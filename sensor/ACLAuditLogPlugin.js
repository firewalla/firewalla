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
const vpnProfileManager = require('../net2/VPNProfileManager.js');
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();
const timeSeries = require("../util/TimeSeries.js").getTimeSeries()
const Constants = require('../net2/Constants.js');

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
    this.buffer = { ip: {}, dns: {}, dnsA: {} }
    this.bufferTs = Date.now() / 1000
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

    sem.on(Message.MSG_ACL_DNS_NXDOMAIN, message => {
      if (message && message.record)
        this._processDnsRecord(message.record)
          .catch(err => log.error('Failed to process record', err, message.record))
    });
    sem.on(Message.MSG_ACL_DNS_UNCATEGORIZED, message => {
      if (message && message.record) {
        this._processDnsRecord(message.record, false)
          .catch(err => log.error('Failed to process record', err, message.record))
      }
    });
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

  // Jul  2 16:35:57 firewalla kernel: [ 6780.606787] [FW_ACL_AUDIT]IN=br0 OUT=eth0 PHYSIN=eth1.999 MAC=20:6d:31:fe:00:07:88:e9:fe:86:ff:94:08:00 SRC=192.168.210.191 DST=23.129.64.214 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=63349 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0 MARK=0x87
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
    let mac, srcMac, dstMac, intf, localIP, remoteIP
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
          // ignore icmp packets
          if (record.pr == 'icmp') return
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
        case 'MAC': {
          dstMac = v.substring(0, 17).toUpperCase()
          srcMac = v.substring(18, 35).toUpperCase()
          break;
        }
        case 'IN': {
          // always use IN for interface
          // when traffic coming from external network, it'll hit WAN interface and that's what we want
          intf = sysManager.getInterface(v)
          record.intf = intf.uuid
          break;
        }
        default:
      }
    }

    if (sysManager.isMulticastIP(record.dh, intf.name, false)) return

    // check direction, keep it same as flow.fd
    // in, initiated from inside
    // out, initated from outside
    const wanIPs = sysManager.myWanIps()
    const srcIsLocal = sysManager.isLocalIP(record.sh) || wanIPs.v4.includes(record.sh) || wanIPs.v6.includes(record.sh)
    const dstIsLocal = sysManager.isLocalIP(record.dh) || wanIPs.v4.includes(record.dh) || wanIPs.v6.includes(record.dh)

    if (srcIsLocal) {
      mac = srcMac;
      localIP = record.sh
      remoteIP = record.dh

      if (dstIsLocal)
        record.fd = 'lo';
      else
        record.fd = 'in';
    } else if (dstIsLocal) {
      record.fd = 'out';
      mac = dstMac;
      localIP = record.dh
      remoteIP = record.sh
    } else {
      return
    }

    // broadcast mac address
    if (mac == 'FF:FF:FF:FF:FF:FF') return

    // local IP being Firewalla's own interface, use if:<uuid> as "mac"
    if (new Address4(localIP).isValid() ? sysManager.isMyIP(localIP, false) : sysManager.isMyIP6(localIP, false)) {
      log.debug(line)
      mac = `${Constants.NS_INTERFACE}:${intf.uuid}`
    }

    if (intf.name === "tun_fwvpn") {
      const vpnProfile = vpnProfileManager.getProfileCNByVirtualAddr(localIP);
      if (!vpnProfile) throw new Error('VPNProfile not found for', localIP);
      mac = `${Constants.NS_VPN_PROFILE}:${vpnProfile}`;
      record.rl = vpnProfileManager.getRealAddrByVirtualAddr(localIP);
    }

    // TODO: is dns resolution necessary here?
    const domain = await dnsTool.getDns(remoteIP);
    if (domain)
      record.dn = domain;

    this.writeBuffer(mac, remoteIP, record)
  }

  async _processDnsRecord(record, block = true) {
    // assume that DNS requests will only come from local network
    record.fd = 'in'

    const intf = new Address4(record.sh).isValid() ?
      sysManager.getInterfaceViaIP4(record.sh, false) :
      sysManager.getInterfaceViaIP6(record.sh, false)

    if (!intf) {
      log.debug('Interface not found for', record.sh);
      return null
    }

    record.intf = intf.uuid

    let mac
    if (intf.name === "tun_fwvpn") {
      const vpnProfile = vpnProfileManager.getProfileCNByVirtualAddr(record.sh);
      if (!vpnProfile) throw new Error('VPNProfile not found for', record.sh);
      mac = `${Constants.NS_VPN_PROFILE}:${vpnProfile}`;
      record.rl = vpnProfileManager.getRealAddrByVirtualAddr(record.sh);
    } else {
      mac = await hostTool.getMacByIPWithCache(record.sh, false);
    }

    if (!mac) {
      log.debug('MAC address not found for', record.sh)
      return
    }

    record.type = block ? 'dns' : 'dnsA';
    record.ct = 1;
    if (!block) record.dn = 'all'

    this.writeBuffer(mac, record.dn, record)
  }

  _getAuditDropKey(mac) {
    return `audit:drop:${mac}`;
  }

  async writeLogs() {
    try {
      log.debug('Start writing logs', this.bufferTs)
      // log.debug(JSON.stringify(this.buffer))

      const buffer = this.buffer
      this.buffer = { ip: {}, dns: {}, dnsA: {} }

      for (const type in buffer) {
        for (const mac in buffer[type]) {
          for (const target in buffer[type][mac]) {
            const record = buffer[type][mac][target];
            const {ts, ct, intf} = record
            const tags = []
            if (
              !mac.startsWith(Constants.NS_VPN_PROFILE + ':') &&
              !mac.startsWith(Constants.NS_INTERFACE + ':')
            ) {
              const host = hostManager.getHostFastByMAC(mac);
              if (host) tags.push(...await host.getTags())
            }
            const networkProfile = networkProfileManager.getNetworkProfile(intf);
            if (networkProfile) tags.push(...networkProfile.getTags());
            record.tags = _.uniq(tags)

            // no detailed history and stats for uncategorized dns queries
            if (type != 'dnsA') {
              const key = this._getAuditDropKey(mac);
              await rclient.zaddAsync(key, ts, JSON.stringify(record));
            }

            const hitType = type == 'dnsA' ? 'dns' : `${type}B`
            timeSeries.recordHit(`${hitType}`, ts, ct)
            timeSeries.recordHit(`${hitType}:${mac}`, ts, ct)
            timeSeries.recordHit(`${hitType}:intf:${intf}`, ts, ct)
            for (const tag of record.tags) {
              timeSeries.recordHit(`${hitType}:tag:${tag}`, ts, ct)
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
