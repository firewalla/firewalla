/*    Copyright 2016-2022 Firewalla Inc.
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
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager();
const DNSTool = require('./DNSTool.js');
const dnsTool = new DNSTool();
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const {getPreferredName} = require('../util/util.js');
const mustache = require('mustache');

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
          case "alert": {
            this.processAlertEvent(obj).catch((err) => {
              log.error(`Failed to process alert event: ${line}`, err.message);
            });
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
    const alert = e && e.alert;
    if (!alert)
      return;
    const signature = alert.signature;
    const category = alert.category;
    const severity = alert.severity;
    const srcIp = e.src_ip;
    const dstIp = e.dest_ip;
    if (!srcIp || !dstIp || !signature)
      return;
    let description = signature;
    let srcOrig = true;
    try {
      // try to parse signature as a JOSN object
      const signatureObj = JSON.parse(signature);
      description = signatureObj.description;
      if (signatureObj.hasOwnProperty("srcOrig"))
        srcOrig = signatureObj.srcOrig;
    } catch (err) {}
    const sport = e.src_port;
    const dport = e.dest_port;
    const proto = e.proto;
    const appProto = e.app_proto;
    const ts = e.timestamp && (Date.parse(e.timestamp) / 1000);
    let srcName = srcIp;
    let dstName = dstIp;
    let localIP, remoteIP, localPort, remotePort;
    let srcLocal = true;
    let dstLocal = false;
    if (sysManager.isLocalIP(srcIp)) {
      localIP = srcIp;
      localPort = sport;
      const device = await dnsManager.resolveLocalHostAsync(srcIp);
      if (device)
        srcName = getPreferredName(device);
    } else {
      srcLocal = false;
      remoteIP = srcIp;
      remotePort = sport;
      const host = await dnsTool.getDns(srcIp);
      if (host)
        srcName = host;
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
      const device = await dnsManager.resolveLocalHostAsync(dstIp);
      if (device)
        dstName = getPreferredName(device);
    } else {
      if (!srcLocal) {
        log.error(`Should not get alert on external traffic: ${srcIp} --> ${dstIp}`);
        return;
      }
      remoteIP = dstIp;
      remotePort = dport;
      const host = await dnsTool.getDns(dstIp);
      if (host)
        dstName = host;
    }
    let localOrig;
    if (srcLocal && srcOrig || dstLocal && !srcLocal && !srcOrig)
      localOrig = true;
    else
      localOrig = false;
    const variableMap = {
      "SRC": srcName,
      "DST": dstName,
      "SPORT": sport,
      "DPORT": dport,
      "PROTO": proto,
      "APP_PROTO": appProto,
      "FD": localOrig ? "outbound" : "inbound" 
    };
    const message = mustache.render(description, variableMap);
    log.info("alert message", message);
    const alarmPayload = {
      "p.device.ip": localIP,
      "p.dest.ip": remoteIP,
      "p.local_is_client": localOrig ? "1" : "0",
      "p.protocol": proto,
      "p.security.category": category,
      "p.security.severity": severity,
      "p.security.source": "suricata",
      "p.description": message
    }
    if (localPort)
      alarmPayload["p.device.port"] = [localPort];
    if (remotePort)
      alarmPayload["p.dest.port"] = remotePort;
    if (appProto)
      alarmPayload["p.app.protocol"] = appProto;
    
    const alarm = new Alarm.CustomizedSecurityAlarm(ts, localIP, alarmPayload);
    am2.enqueueAlarm(alarm);
  }
}

module.exports = new SuricataDetect();