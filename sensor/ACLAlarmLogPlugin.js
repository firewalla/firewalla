/*    Copyright 2016-2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const f = require('../net2/Firewalla.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sysManager = require('../net2/SysManager.js');
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();
const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();
const Alarm = require('../alarm/Alarm.js');
const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const LogReader = require('../util/LogReader.js');

const exec = require('child-process-promise').exec;
const _ = require('lodash');
const LRU = require('lru-cache');
const sem = require('./SensorEventManager.js').getInstance();
const {getPreferredName} = require('../util/util.js');
const DNSManager = require('../net2/DNSManager.js');
const dnsManager = new DNSManager();
const mustache = require("mustache");

const LOG_PREFIX = "[FW_ALM]";

const alarmLogFile = "/alog/acl-alarm.log";

class ACLAlarmLogPlugin extends Sensor {
  constructor(config) {
    super(config);
    this.featureName = "acl_alarm";
    this.recentMatchCache = new LRU({maxAge: 600 * 1000, max: 512});
    this.policyCache = new LRU({max: 256});
  }

  hookFeature() {
    if (platform.isAuditLogSupported())
      super.hookFeature()
  }

  async run() {
    this.hookFeature();
    this.alarmLogReader = null;
  }

  async job() {
    super.job();

    sem.on('Policy:Updated', (event) => {
      const pid = event && event.pid;
      if (!isNaN(pid)) {
        this.policyCache.del(Number(pid));
      }
    });

    this.alarmLogReader = new LogReader(alarmLogFile);
    this.alarmLogReader.on('line', this._processAlarmLog.bind(this));
    this.alarmLogReader.watch();
  }

  // Oct 28 11:27:45 localhost kernel: [157340.932724@5] [FW_ALM]PID=5 IN=br0 OUT=eth0 PHYSIN=eth1 MAC=20:6d:31:ee:f2:2e:00:e0:4c:68:00:0b:08:00 SRC=192.168.45.158 DST=151.101.129.67 LEN=52 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=54571 DPT=443 WINDOW=7966 RES=0x00 ACK URGP=0 MARK=0x80000000
  async _processAlarmLog(line) {
    if (_.isEmpty(line))
      return;

    const ts = Date.now() / 1000;
    // extract content after log prefix
    const content = line.substring(line.indexOf(LOG_PREFIX) + LOG_PREFIX.length);
    if (!content || content.length == 0)
      return;
    const params = content.split(' ');
    const record = { ts };
    let inIntf, outIntf;
    for (const param of params) {
      const kvPair = param.split('=');
      if (kvPair.length !== 2 || kvPair[1] == '')
        continue;
      const k = kvPair[0];
      const v = kvPair[1];
      switch (k) {
        case "SRC": {
          record.src = v;
          break;
        }
        case "DST": {
          record.dst = v;
          break;
        }
        case "PROTO": {
          record.proto = v.toLowerCase();
          // ignore icmp packets
          if (record.pr == 'icmp') return
          break;
        }
        case "SPT": {
          record.sport = v;
          break;
        }
        case "DPT": {
          record.dport = v;
          break;
        }
        case 'IN': {
          inIntf = sysManager.getInterface(v)
          break;
        }
        case 'OUT': {
          // when dropped before routing, there's no out interface
          outIntf = sysManager.getInterface(v)
          break;
        }
        case 'PID': {
          if (!isNaN(v))
            record.pid = Number(v);
          else return;
          break;
        }
        default:
      }
    }
    if (!record.pid || !record.src || !record.dst) return;
    if (!inIntf || !outIntf) return; // this should not happen as alarm log should only be triggered on forwarded packets
    if (this.recentMatchCache.has(`${record.src}_${record.dst}_${record.pid}`)) return; // do not repeatedly process logs with same src/dst/pid as a recently populated alarm

    if (sysManager.isMulticastIP(record.dst, outIntf && outIntf.name || inIntf.name, false)) return;
    if (sysManager.isMyIP(record.dst) || sysManager.isMyIP(record.src) || sysManager.isMyIP6(record.dst) || sysManager.isMyIP6(record.src)) return;
    this.recentMatchCache.set(`${record.src}_${record.dst}_${record.pid}`);
    // defer populateAlarm in case DNS mappings is not updated 
    setTimeout(() => {
      this._populateAlarm(record).catch((err) => {
        log.error("Failed to populate alarm from record", record, err);
      });
    }, 10000);
  }

  async _getPolicy(pid) {
    if (this.policyCache.has(pid))
      return this.policyCache.get(pid);
    
    const policy = await pm2.getPolicy(pid);
    if (policy) {
      this.policyCache.set(pid, policy);
      return policy;
    }
    return null;
  }

  _portInRange(p, r) {
    if (p == r)
      return true;
    if (_.isString(r)){
      const [begin, end] = r.split("-", 2).map(n => Number(n));
      if (Number(p) >= begin || Number(p) <= end)
        return true;
    }
    return false;
  }

  async _populateAlarm(record) {
    const {pid, src, dst, sport, dport, proto} = record;
    let localIP, remoteIP, localPort, remotePort, dir, remoteUID, localUID;
    const policy = await this._getPolicy(pid);
    if (!policy) {
      log.error(`Cannot find policy with pid ${pid}`);
      return;
    }
    let srcName = src;
    let dstName = dst;
    if (sysManager.isLocalIP(src)) {
      localIP = src;
      localPort = sport;
      remoteIP = dst;
      remotePort = dport;
      dir = "outbound";
      const device = await dnsManager.resolveLocalHostAsync(localIP);
      if (device)
        srcName = getPreferredName(device);
    } else {
      if (sysManager.isLocalIP(dst)) {
        localIP = dst;
        localPort = dport;
        remoteIP = src;
        remotePort = sport;
        dir = "inbound";
        const device = await dnsManager.resolveLocalHostAsync(localIP);
        if (device)
          dstName = getPreferredName(device);
      } else return;
    }

    const alarmPayload = {
      "p.device.ip": localIP,
      "p.dest.ip": remoteIP,
      "p.local_is_client": dir === "outbound" ? "1" : "0",
      "p.device.port": [localPort],
      "p.dest.port": remotePort,
      "p.pid": pid,
      "p.protocol": proto
    };

    if (policy.cooldown)
      alarmPayload["p.cooldown"] = policy.cooldown;

    localUID = localIP;
    remoteUID = remoteIP;
    if (policy.type === "dns" || policy.type === "domain" || policy.type === "category") {
      let domains = await dnsTool.getAllDns(remoteIP);
      if (domains.length > 10)
        domains = domains.slice(0, 10);
      // try to get host from intel
      const intel = await intelTool.getIntel(remoteIP);
      if (intel && intel.host)
        domains.push(intel.host);
      if (policy.type === "dns" || policy.type === "domain") {
        const matchedDomain = domains.find(d => policy.target.startsWith("*.") ? (d.endsWith(policy.target.substring(1)) || d === policy.target.substring(2)) : d === policy.target || d.endsWith(`.${policy.target}`));
        if (!matchedDomain)
          return;
        remoteUID = matchedDomain;
        alarmPayload["p.dest.name"] = matchedDomain;
      }
      if (policy.type === "category") {
        const categoryDomains = categoryUpdater.getEffectiveDomains(policy.target) || new Map();
        let matchedDomain;
        for (const d of domains) {
          for (const [k, domainObj] of categoryDomains) {
            const cd = domainObj.id;
            if (cd.startsWith("*.") ? (d.endsWith(cd.substring(1)) || d === cd.substring(2)) : cd === d) {
              matchedDomain = d;
            }
          }
        }
        if (!matchedDomain)
          return;
        remoteUID = matchedDomain;
        alarmPayload["p.dest.name"] = matchedDomain;
        alarmPayload["p.dest.category"] = policy.target;
      }
      alarmPayload["p.ignoreDestIntel"] = "1"; // do not call DestInfoIntel.enrichAlarm in case it messed up p.dest.name
    }
    if (alarmPayload["p.dest.name"]) {
      if (dir === "outbound")
        dstName = alarmPayload["p.dest.name"];
      else
        srcName = alarmPayload["p.dest.name"];
    }
    if (policy.localPort) {
      if (this._portInRange(localPort, policy.localPort)) {
        localUID = `${localUID}_${localPort}`;
      } else {
        if (this._portInRange(remotePort, policy.localPort)) {
          // this usually happens on rules that are applied on local traffic
          remoteUID = `${remoteUID}_${remotePort}`;
        } else return;
      }
    }
    if (policy.remotePort) {
      if (this._portInRange(remotePort, policy.remotePort)) {
        remoteUID = `${remoteUID}_${remotePort}`;
      } else {
        if (this._portInRange(localPort, policy.remotePort)) {
          localUID = `${localUID}_${localPort}`;
        } else return;
      }
    }

    alarmPayload["p.local.uid"] = localUID;
    alarmPayload["p.remote.uid"] = remoteUID;

    const variableMap = {
      "SRC": srcName,
      "DST": dstName,
      "SPORT": sport,
      "DPORT": dport,
      "PROTO": proto
    };

    if (policy.notifMsg) {
      alarmPayload["p.notif.message"] = mustache.render(policy.notifMsg, variableMap);
    }

    const alarm = new Alarm.CustomizedAlarm(Date.now() / 1000, localIP, alarmPayload);
    am2.enqueueAlarm(alarm);
  }

  async globalOn() {
    super.globalOn()
    await exec(`${f.getFirewallaHome()}/scripts/alarm-run`)
  }

  async globalOff() {
    super.globalOff()
    await exec(`${f.getFirewallaHome()}/scripts/alarm-stop`)
  }
}

module.exports = ACLAlarmLogPlugin;