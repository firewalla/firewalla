/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require('./logger.js')(__filename);

const LogReader = require('../util/LogReader.js');
const sysManager = require('./SysManager.js');
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const DNSTool = require('./DNSTool.js');
const dnsTool = new DNSTool();
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const {getPreferredName} = require('../util/util.js');
const mustache = require('mustache');
const conntrack = require('./Conntrack.js');
const Constants = require('./Constants.js');
const _ = require('lodash');
const fc = require('./config.js');
const LRU = require('lru-cache');
const HostTool = require('./HostTool.js');

const hostTool = new HostTool();

// Cache for rate limiting alarm generation - 5 minutes TTL
const alarmRateLimitCache = new LRU({
  max: 1000, // Maximum number of entries
  maxAge: 5 * 60 * 1000, // 5 minutes in milliseconds
  updateAgeOnGet: false,
  allowStale: false
});

class SuricataDetect {
  constructor(logDir = "/log/slog") {
    this.logDir = logDir;
  }

  async initWatchers() {
    log.info("Initializing Suricata log watchers ...");
    const reader = new LogReader(`${this.logDir}/eve.json`);
    reader.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        switch (obj.event_type) {
          case "alert":
          // an inline drop record is the same hit as its alert, the rate limit below keeps one alarm for the two
          case "drop": {
            // add a timeout before processing alert event for syncing contextual information to redis, e.g., hostname from ssl/http connections
            setTimeout(() => {
              this.processAlertEvent(obj).catch((err) => {
                log.error(`Failed to process alert event: ${line}`, err.message);
              });
            }, 15000);
            break;
          }
          default:
        }
      } catch (err) {
        log.info(`Failed to process eve.json output: ${line}`, err.message);
      }
    });
    reader.watch();
  }

  async processAlertEvent(e) {
    // Check if cyber_security feature is enabled
    if (!fc.isFeatureOn('cyber_security')) {
      return;
    }
    
    const alert = e && e.alert;
    if (!alert)
      return;

    const {signature, signature_id, rev, gid, category, severity, metadata, action} = alert; // action: "blocked" or "allowed"
    if (!e.src_ip || !e.dest_ip || !signature)
      return;
    let description = signature;
    let alarmData = null;
    // the rule may say which side of the matched packet opened the connection, overriding e.direction
    let signatureSrcOrig = undefined;
    try {
      // try to parse signature as a JOSN object
      const signatureObj = JSON.parse(signature);
      description = signatureObj.description;
      if (signatureObj.hasOwnProperty("alarmData") && _.isObject(signatureObj.alarmData))
        alarmData = signatureObj.alarmData
      if (signatureObj.hasOwnProperty("srcOrig"))
        signatureSrcOrig = signatureObj.srcOrig;
    } catch (err) {}
    const proto = e.proto; // "TCP", "UDP" or "ICMP"
    const appProto = e.app_proto; // e.g. "http", "tls"
    const ts = e.timestamp && (Date.parse(e.timestamp) / 1000);

    const ends = await this.resolveEnds(e, signatureSrcOrig);
    if (!ends)
      return;
    const { localIP, localPort, intfId, remoteIP, remotePort, remoteName, srcName, dstName, localOrig } = ends;

    const alertDedupKey = `${localIP}:${remoteIP}:${signature_id}`; // one alarm per device, server and rule in 5 minutes
    
    // Rate limiting: check if we've recently generated an alarm for this key
    if (alarmRateLimitCache.has(alertDedupKey)) {
      log.info(`Rate limiting alarm for key: ${alertDedupKey} - similar alarm generated within last 5 minutes`);
      return;
    }
    
    // Add to cache to prevent future alarms for 5 minutes
    alarmRateLimitCache.set(alertDedupKey, Date.now());
    const variableMap = {
      "SRC": srcName,
      "DST": dstName,
      "SPORT": e.src_port,
      "DPORT": e.dest_port,
      "PROTO": proto,
      "APP_PROTO": appProto,
      "FD": localOrig ? "outbound" : "inbound" 
    };
    const message = mustache.render(description, variableMap);
    log.info("alert message", message);
    const alarmPayload = {
      "p.device.ip": localIP,
      "p.dest.name": remoteName,
      "p.dest.ip": remoteIP,
      "p.local_is_client": localOrig ? "1" : "0",
      "p.protocol": proto,
      "p.suricata.category": category,
      "p.suricata.severity": severity,
      "p.suricata.signatureId": signature_id,
      "p.suricata.gid": gid,
      "p.suricata.rev": rev,
      "p.event.ts": ts,
      "p.message": message
    }
    if (_.isObject(alarmData) && !_.isEmpty(alarmData)) {
      for (const key of Object.keys(alarmData)) {
        alarmPayload[`p.suricata.extra.${key}`] = alarmData[key];
      }
    }
    // "blocked" when the engine has already cut the connection (only informational)
    if (action)
      alarmPayload["p.ips.action"] = action;
    if (intfId)
      alarmPayload["p.intf.id"] = intfId;
    if (localPort)
      alarmPayload["p.device.port"] = [localPort];
    if (remotePort)
      alarmPayload["p.dest.port"] = remotePort;
    if (appProto)
      alarmPayload["p.app.protocol"] = appProto;
    if (_.isObject(metadata)) {
      for (const key of Object.keys(metadata)) {
        alarmPayload[`p.suricata.metadata.${key}`] = metadata[key];
      }
    }
    
    const alarm = new Alarm.SuricataNoticeAlarm(ts, localIP, alarmPayload);
    am2.enqueueAlarm(alarm);
  }

  // eve's src and dest are the sender and receiver of the packet the rule matched, which is the server's
  // reply for a to_client rule; this works out our device, the other side, and who opened the connection.
  // Returns null when the alert should be dropped: no local end, or recording is off for the device
  async resolveEnds(e, signatureSrcOrig) {
    const srcIp = e.src_ip;
    const dstIp = e.dest_ip;
    const sport = e.src_port;
    const dport = e.dest_port;
    const proto = e.proto;

    // whether the sender of the matched packet opened the connection
    let srcOrig = true;
    if (e.direction === "to_client" || e.direction === "from_server")
      srcOrig = false;
    if (signatureSrcOrig !== undefined)
      srcOrig = signatureSrcOrig;

    // domain of the connection (HTTP host, TLS SNI), if any
    let hostname = srcOrig ? await conntrack.getConnEntry(srcIp, sport, dstIp, dport, proto, Constants.REDIS_HKEY_CONN_HOST) : await conntrack.getConnEntry(dstIp, dport, srcIp, sport, proto, Constants.REDIS_HKEY_CONN_HOST);
    let srcName = srcIp; // shown in the message: device name or domain
    let dstName = dstIp;
    let localIP, remoteIP, remoteName, localPort, remotePort;
    let srcLocal = true;
    let dstLocal = false;
    let intfId = null; // network of the local device
    if (sysManager.isLocalIP(srcIp)) {
      localIP = srcIp;
      localPort = sport;
      const host = await hostManager.getIdentityOrHost(srcIp);
      if (host) {
        srcName = host.getReadableName();
        intfId = host.getNicUUID();
        if (!await hostTool.isRecordingOn(host, intfId))
          return null;
      }
    } else {
      srcLocal = false;
      remoteIP = srcIp;
      remotePort = sport;
      const host = hostname || await dnsTool.getDns(srcIp);
      if (host) {
        srcName = host;
        remoteName = host;
      }
    }
    if (sysManager.isLocalIP(dstIp)) {
      dstLocal = true;
      if (srcLocal) {
        remoteIP = dstIp;
        remotePort = dport;
      } else {
        localIP = dstIp;
        localPort = dport;
      }
      const host = await hostManager.getIdentityOrHost(dstIp);
      if (host) {
        dstName = host.getReadableName();
        intfId = host.getNicUUID();
        if (!await hostTool.isRecordingOn(host, intfId))
          return null;
      }
    } else {
      if (!srcLocal) {
        log.error(`Should not get alert on external traffic: ${srcIp} --> ${dstIp}`);
        return null;
      }
      remoteIP = dstIp;
      remotePort = dport;
      const host = hostname || await dnsTool.getDns(dstIp);
      if (host) {
        dstName = host;
        remoteName = host;
      }
    }

    // our device opened the connection, whether the matched packet was its request or the reply to it
    const localOrig = srcLocal && srcOrig || dstLocal && !srcLocal && !srcOrig;
    return { localIP, localPort, intfId, remoteIP, remotePort, remoteName, srcName, dstName, localOrig };
  }
}

module.exports = new SuricataDetect();
