/*    Copyright 2016-2021 Firewalla Inc
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
const exec = require('child-process-promise').exec;
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');
const LOG_PREFIX = "[FW_ACL_AUDIT]";
const SECLOG_PREFIX = "[FW_SEC_AUDIT]";
const {Address4, Address6} = require('ip-address');
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();
const networkProfileManager = require('../net2/NetworkProfileManager')
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();
const timeSeries = require("../util/TimeSeries.js").getTimeSeries()

const os = require('os')
const util = require('util')
const fs = require('fs')
const openAsync = util.promisify(fs.open)
const net = require('net')
const readline = require('readline')

const _ = require('lodash')

const auditLogFile = "/log/alog/acl-audit-pipe";

const featureName = "acl_audit";

class ACLAuditLogPlugin extends Sensor {
  constructor() {
    super()

    this.startTime = (Date.now() - os.uptime()*1000) / 1000
    this.buffer = { ip: {}, dns: {}, ts: Date.now() / 1000 }
  }

  async run() {
    this.hookFeature(featureName);
    this.auditLogReader = null;
    this.aggregator = null
  }

  async job() {
    try {
      const fd = await openAsync(auditLogFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      const pipe = new net.Socket({ fd });
      pipe.on('ready', () => {
        log.info("Pipe ready");
      })
      pipe.on('error', (err) => {
        log.error("Error while reading acl audit log", err.message);
      })
      const reader = readline.createInterface({input: pipe})
      reader.on('line', line => {
        this._processIptablesLog(line)
          .catch(err => log.error('Failed to process log', err, line))
      });
    } catch(err) {
      log.error('Error reading pipe', err)
    }

    sem.on(Message.MSG_ACL_DNS_NXDOMAIN, (message) => {
      if (message && message.record)
        this._processDnsNxdomainRecord(message.record)
          .catch(err => log.error('Failed to process record', err, message.record))
    });
  }

  getIntfViaIP(ip) {
    return new Address4(ip).isValid() ? sysManager.getInterfaceViaIP4(ip) : sysManager.getInterfaceViaIP6(ip)
  }

  // check direction, keep it same as flow.fd
  // in, initiated from inside
  // out, initated from outside
  setDirection(record) {
    if (sysManager.isLocalIP(record.sh)) {
      record.fd = 'in';
    } else if (sysManager.isLocalIP(record.dh)) {
      record.fd = 'out';
    } else {
      record.fd = 'lo';
    }
  }

  writeBuffer(mac, target, record) {
    const bucket = this.buffer[record.type]
    if (!bucket[mac]) bucket[mac] = {}
    if (bucket[mac][target]) {
      const s = bucket[mac][target]
      // _.min() and _.max() will ignore non-number values
      s.ts = _.min([s.ts, record.ts])
      s.ets = _.max([s.ts, s.ets, record.ts, record.ets])
      s.ct += record.ct
      if (s.sp) s.sp = _.uniq(s.sp, record.sp)
    } else {
      bucket[mac][target] = record
    }
  }

  // Jul  2 16:35:57 firewalla kernel: [ 6780.606787] [FW_ACL_AUDIT]IN=br0 OUT=eth0 MAC=20:6d:31:fe:00:07:88:e9:fe:86:ff:94:08:00 SRC=192.168.210.191 DST=23.129.64.214 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=63349 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0 MARK=0x87
  // THIS MIGHT BE A BUG: The calculated timestamp seems to always have a few seconds gap with real event time, but the gap is constant. The readable time seem to be accurate, but precision is not enough for event order distinguishing
  async _processIptablesLog(line) {
    // log.debug(line)
    const uptime = Number(line.match(/\[\s*([\d.]+)\]/)[1])
    const ts = Math.round((this.startTime + uptime) * 1000) / 1000;
    const secTagIndex = line.indexOf(SECLOG_PREFIX)
    const security = secTagIndex > 0
    // extract content after log prefix
    const content = line.substring(security ?
      secTagIndex + SECLOG_PREFIX.length : line.indexOf(LOG_PREFIX) + LOG_PREFIX.length
    );
    if (!content || content.length == 0)
      return;
    const params = content.split(' ');
    const record = { ts, type: 'ip', ct: 1};
    if (security) record.sec = 1
    for (const param of params) {
      const kvPair = param.split('=');
      if (kvPair.length !== 2)
        continue;
      const k = kvPair[0];
      const v = kvPair[1];
      switch (k) {
        case "SRC": {
          record.sh = v;
          break;
        }
        case "DST": {
          record.dh = v;
          break;
        }
        case "PROTO": {
          record.pr = v.toLowerCase();
          break;
        }
        case "SPT": {
          record.sp = [ Number(v) ];
          break;
        }
        case "DPT": {
          record.dp = Number(v);
          break;
        }
        default:
      }
    }

    this.setDirection(record)
    // unless we can get interface info from zeek, local traffic will cause duplication
    if (record.rd == 'lo') return


    const localIP = record.fd == 'out' ? record.dh : record.sh
    const remoteIP = record.fd == 'out' ? record.sh : record.dh

    const intf = this.getIntfViaIP(localIP)
    // not able to map ip to unique identity from VPN yet
    if (!intf || intf.name === "tun_fwvpn")
      return;
    record.intf = intf.uuid

    const mac = await hostTool.getMacByIPWithCache(localIP);
    if (mac) {
      // TODO: is dns resolution necessary here?
      if (!sysManager.isLocalIP(remoteIP)) {
        const domain = await dnsTool.getDns(remoteIP);
        if (domain)
          record.dn = domain;
      }

      this.writeBuffer(mac, remoteIP, record)
    }
  }

  async _processDnsNxdomainRecord(record) {
    this.setDirection(record)
    // unless we can get interface info from zeek, local traffic will cause duplication
    if (record.rd == 'lo') return

    const localIP = record.fd == 'out' ? record.dh : record.sh
    const intf = this.getIntfViaIP(localIP)
    // not able to map ip to unique identity from VPN yet
    if (!intf || intf.name === "tun_fwvpn")
      return;
    record.intf = intf.uuid

    const mac = await hostTool.getMacByIPWithCache(localIP);
    if (mac) {
      record.type = "dns";
      record.ct = 1;

      this.writeBuffer(mac, record.dn, record)
    }
  }

  _getAuditDropKey(mac) {
    return `audit:drop:${mac}`;
  }

  async writeLogs() {
    try {
      log.debug('Start writing logs', this.buffer.ts)
      // log.debug(JSON.stringify(this.buffer))

      const buffer = this.buffer
      this.buffer = { ip: {}, dns: {}, ts: Date.now() / 1000 }

      for (const type in buffer) {
        for (const mac in buffer[type]) {
          for (const target in buffer[type][mac]) {
            const key = this._getAuditDropKey(mac);
            const record = buffer[type][mac][target];
            const {ts, ct, intf} = record
            const tags = []
            const host = hostManager.getHostFastByMAC(mac);
            if (!host) continue
            tags.push(...await host.getTags())
            const networkProfile = networkProfileManager.getNetworkProfile(intf);
            if (!networkProfile) continue
            tags.push(...networkProfile.getTags());
            record.tags = _.uniq(tags)

            await rclient.zaddAsync(key, ts, JSON.stringify(record));

            timeSeries.recordHit(`${type}B`, ts, ct)
            timeSeries.recordHit(`${type}B:${mac}`, ts, ct)
            timeSeries.recordHit(`${type}B:intf:${intf}`, ts, ct)
            for (const tag of record.tags) {
              timeSeries.recordHit(`${type}B:tag:${tag}`, ts, ct)
            }
          }
        }
      }
      timeSeries.exec()
    } catch(err) {
      log.error("Failed to write audit logs", err)
    }
  }

  // Works similar to flowStash in BroDetect, reduce memory is the main purpose here
  async mergeLogs(startOpt, endOpt) {
    try {
      const end = endOpt || Math.floor(new Date() / 1000 / this.config.interval) * this.config.interval
      const start = startOpt || end - this.config.interval
      log.info('Start merging', start, end)
      const auditKeys = await rclient.scanResults(this._getAuditDropKey('*'), 1000)
      log.info('Key(mac) count: ', auditKeys.length)

      for (const key of auditKeys) {
        const records = await rclient.zrangebyscoreAsync(key, start, end)
        // const mac = key.substring(11) // audit:drop:<mac>

        const stash = {}
        for (const recordString of records) {
          try {
            const record = JSON.parse(recordString)
            const target = record.type == 'dns' ? record.dn :
                           record.fd == 'in' ? record.dh : record.sh // type === 'ip'
            if (!target)
              log.error('MergeLogs: Invalid target', record)

            const descriptor = `${record.type}:${target}:${record.dp || ''}:${record.fd}`

            if (stash[descriptor]) {
              const s = stash[descriptor]
              // _.min() and _.max() will ignore non-number values
              s.ts = _.min([s.ts, record.ts])
              s.ets = _.max([s.ts, s.ets, record.ts, record.ets])
              s.ct += record.ct
              if (s.sp) s.sp = _.uniq(s.sp, record.sp)
            } else {
              stash[descriptor] = record
            }
          } catch(err) {
            log.error('Failed to process record', err, recordString)
          }
        }

        const transaction = [];
        transaction.push(['zremrangebyscore', key, start, end]);
        for (const descriptor in stash) {
          const record = stash[descriptor]
          transaction.push(['zadd', key, record.ets || record.ts, JSON.stringify(record)])
        }
        if (this.config.expires) {
          transaction.push(['expireat', key, parseInt(new Date / 1000) + this.config.expires])
        }

        // catch this to proceed onto the next iteration
        try {
          log.debug(transaction)
          await rclient.multi(transaction).execAsync();
          log.debug("Audit:Save:Removed", key);
        } catch (err) {
          log.error("Audit:Save:Error", err);
        }
      }

    } catch(err) {
      log.error("Failed to merge audit logs", err)
    }
  }

  async globalOn() {
    await exec(`${f.getFirewallaHome()}/scripts/audit-run`)

    this.bufferDumper = this.bufferDumper || setInterval(this.writeLogs.bind(this), (this.config.buffer || 30) * 1000)
    this.aggregator = this.aggregator || setInterval(this.mergeLogs.bind(this), (this.config.interval || 300) * 1000)
  }

  async globalOff() {
    await exec(`${f.getFirewallaHome()}/scripts/audit-stop`)

    clearInterval(this.bufferDumper)
    clearInterval(this.aggregator)
    this.bufferDumper = this.aggregator = undefined
  }

}

module.exports = ACLAuditLogPlugin;
