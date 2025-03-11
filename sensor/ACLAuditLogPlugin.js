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

const net = require('net')
const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();
const networkProfileManager = require('../net2/NetworkProfileManager')
const IdentityManager = require('../net2/IdentityManager.js');
const TagManager = require('../net2/TagManager.js');
const timeSeries = require("../util/TimeSeries.js").getTimeSeries()
const Constants = require('../net2/Constants.js');
const fc = require('../net2/config.js')
const conntrack = require('../net2/Conntrack.js')
const LogReader = require('../util/LogReader.js');
const { delay } = require('../util/util.js');
const { getUniqueTs } = require('../net2/FlowUtil.js')
const FireRouter = require('../net2/FireRouter.js');

const { Address4, Address6 } = require('ip-address');
const exec = require('child-process-promise').exec;
const _ = require('lodash');
const sl = require('./SensorLoader.js');
const Message = require('../net2/Message.js');

const LOG_PREFIX = Constants.IPTABLES_LOG_PREFIX_AUDIT

const auditLogFile = "/alog/acl-audit.log";
const dnsmasqLog = "/alog/dnsmasq-acl.log"

const labelReasonMap = {
  "adblock": "adblock",
  "adblock_strict_block": "adblock",
  "default_c_block": "active_protect",
  "default_c_block_high": "active_protect",
  "dns_proxy": "active_protect"
}

const sem = require('./SensorEventManager.js').getInstance();

class ACLAuditLogPlugin extends Sensor {
  constructor(config) {
    super(config)

    this.featureName = Constants.FEATURE_AUDIT_LOG
    this.buffer = {}
    this.touchedKeys = {};
    this.incTs = 0;
  }

  hookFeature() {
    if (platform.isAuditLogSupported()) super.hookFeature()
  }

  async run() {
    this.hookFeature();
    this.auditLogReader = null;
    this.dnsmasqLogReader = null
    this.aggregator = null
    this.ruleStatsPlugin = sl.getSensor("RuleStatsPlugin");
  }

  async job() {
    super.job()

    this.auditLogReader = new LogReader(auditLogFile);
    this.auditLogReader.on('line', this._processIptablesLog.bind(this));
    this.auditLogReader.watch();

    this.dnsmasqLogReader = new LogReader(dnsmasqLog);
    this.dnsmasqLogReader.on('line', this._processDnsmasqLog.bind(this));
    this.dnsmasqLogReader.watch();
  }

  getDescriptor(r) {
    switch (r.type) {
      case 'dns':
        return `${r.ac}:dns:${r.sh}:${r.dn}`
      case 'ntp': // action always redirect
        return `ntp:${r.fd == 'out' ? r.sh : r.dh}:${r.dp}:${r.fd}`
      default:
        return `${r.ac}:${r.tls ? 'tls' : 'ip'}:${r.fd == 'out' ? r.sh : r.dh}:${r.dp}:${r.fd}`
    }
  }

  writeBuffer(record) {
    const { mac } = record
    if (!this.buffer[mac]) this.buffer[mac] = {}
    const descriptor = this.getDescriptor(record)
    if (this.buffer[mac][descriptor]) {
      const s = this.buffer[mac][descriptor]
      // _.min() and _.max() ignore non-number values
      s.ts = _.min([s.ts, record.ts])
      s._ts = _.max([s._ts, record._ts])
      s.du = Math.round((_.max([s.ts + (s.du || 0), record.ts + (record.du || 0)]) - s.ts) * 100) / 100
      s.ct += record.ct
      if (s.sp) s.sp = _.uniq(s.sp, record.sp)
    } else {
      this.buffer[mac][descriptor] = record
    }
  }

  // dns on bridge interface is not the LAN IP, zeek will see different src/dst IP in DNS packets due to br_netfilter,
  // and an additional 10 seconds timeout is introduced before it is recorded in zeek's dns log
  isDNATedOnBridge(inIntf) {
    const pcapZeekPlugin = sl.getSensor("PcapZeekPlugin");

    if (!inIntf || !inIntf.name || !pcapZeekPlugin) return false

    return platform.isFireRouterManaged()
      && inIntf.name.startsWith("br")
      && !_.get(FireRouter.getConfig(), ["dhcp", inIntf.name, "nameservers"], []).includes(inIntf.ip_address)
      && pcapZeekPlugin && pcapZeekPlugin.getListenInterfaces().includes(inIntf.name)
  }

  isPcapOnBridge(inIntf) {
    const pcapZeekPlugin = sl.getSensor("PcapZeekPlugin");

    if (!inIntf || !inIntf.name || !pcapZeekPlugin) return false
    return platform.isFireRouterManaged() && inIntf.name.startsWith("br") && pcapZeekPlugin.getListenInterfaces().includes(inIntf.name);
  }

  // Jul  2 16:35:57 firewalla kernel: [ 6780.606787] [FW_ADT]D=O CD=O IN=br0 OUT=eth0 PHYSIN=eth1.999 MAC=20:6d:31:fe:00:07:88:e9:fe:86:ff:94:08:00 SRC=192.168.210.191 DST=23.129.64.214 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=63349 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0 MARK=0x87
  async _processIptablesLog(line) {
    if (_.isEmpty(line)) return

    // log.debug(line)
    const ts = Date.now() / 1000;
    // extract content after log prefix
    const content = line.substring(line.indexOf(LOG_PREFIX) + LOG_PREFIX.length);
    if (!content || content.length == 0)
      return;
    const params = content.split(' ');
    const record = { ts, type: 'ip', ct: 1, _ts: getUniqueTs(ts) };
    record.ac = "block";
    let mac, srcMac, dstMac, inIntf, outIntf, intf, dIntf, localIP, src, dst, sport, dport,
      dir, ctdir, security, tls, mark, routeMark, wanUUID, inIntfName, outIntfName,
      isolationTagId, isolationNetworkIdPrefix, isoLvl;
    for (const param of params) {
      const kvPair = param.split('=');
      if (kvPair.length !== 2 || kvPair[1] == '')
        continue;
      const k = kvPair[0];
      const v = kvPair[1];
      switch (k) {
        case "SRC": {
          src = v;
          if (src && src.includes(":")) // convert ipv6 address to correct form
            src = new Address6(src).correctForm();
          break;
        }
        case "DST": {
          dst = v;
          if (dst && dst.includes(":"))
            dst = new Address6(dst).correctForm();
          break;
        }
        case "PROTO": {
          record.pr = v.toLowerCase();
          // ignore icmp packets
          if (record.pr == 'icmp' || record.pr === "icmpv6") return
          break;
        }
        case "SPT": {
          sport = v;
          break;
        }
        case "DPT": {
          dport = v;
          break;
        }
        case 'MAC': {
          dstMac = v.substring(0, 17).toUpperCase()
          srcMac = v.substring(18, 35).toUpperCase()
          break;
        }
        case 'IN': {
          inIntf = sysManager.getInterface(v)
          inIntfName = v;
          break;
        }
        case 'OUT': {
          // when dropped before routing, there's no out interface
          outIntf = sysManager.getInterface(v)
          outIntfName = v;
          break;
        }
        case 'D': {
          dir = v;
          break;
        }
        case 'CD': {
          ctdir = v;
          break;
        }
        case 'SEC': {
          if (v === "1")
            security = true;
          break;
        }
        case 'TLS': {
          if (v === "1")
            tls = true;
          break;
        }
        // used only in route log. Abbreviated 'M' to allow for 29bytes -log--prefix limit
        case 'M': {
          routeMark = v;
          break;
        }
        case 'MARK': {
          mark = v;
          break;
        }
        case 'A': {
          switch (v) {
            case "A":
              record.ac = "allow";
              break;
            case "Q":
              record.ac = "qos";
              break;
            case "R":
              record.ac = "route";
              // direction is always outbound and ctdir is always original for route logs
              dir = "O";
              ctdir = "O";
              break;
            case "C":
              record.ac = "conn";
              break
            case "RD":
              record.ac = "redirect";
              break;
            case "I":
              record.ac = "isolation";
              isoLvl = 1;
              break;
          }
          break;
        }
        case 'G': {
          isolationTagId = v;
          isoLvl = 3;
          break;
        }
        case 'N': {
          isolationNetworkIdPrefix = v;
          isoLvl = 2;
        }
        default:
      }
    }

    if (sport && dport && dir) {
      if (dir === "O") {
        if (outIntf)
          wanUUID = outIntf.uuid;
        else {
          if (outIntfName && outIntfName.startsWith(Constants.VC_INTF_PREFIX))
            wanUUID = `${Constants.ACL_VPN_CLIENT_WAN_PREFIX}${outIntfName.substring(Constants.VC_INTF_PREFIX.length)}`;
        }
        conntrack.setConnRemote(record.pr, dst, dport);
      } else if (dir === "I") {
        if (inIntf)
          wanUUID = inIntf.uuid;
        else {
          if (inIntfName && inIntfName.startsWith(Constants.VC_INTF_PREFIX))
            wanUUID = `${Constants.ACL_VPN_CLIENT_WAN_PREFIX}${inIntfName.substring(Constants.VC_INTF_PREFIX.length)}`;
        }
      }
      // record connection in conntrack.js and return
      if (record.ac === "conn") {
        if (wanUUID)
          await conntrack.setConnEntry(src, sport, dst, dport, record.pr, Constants.REDIS_HKEY_CONN_OINTF, wanUUID);
        if (dir == "O" && (record.pr == "udp" || (record.pr == "tcp" && dport != 443 && dport != 80))) {
          // try to resolve hostname shortly after the connection is established in an effort to improve IP-DNS mapping timeliness
          let t = 3;
          if (this.isDNATedOnBridge(inIntf)) {
            t = 13;
          }
          await delay(t * 1000);
          let host = await conntrack.getConnEntry(src, sport, dst, dport, record.pr, "host", 600);
          if (!host) {
            host = await conntrack.getConnEntry(srcMac, "", dst, "", "dns", "host", 600);
            if (host)
              await conntrack.setConnEntries(src, sport, dst, dport, record.pr, {proto: "dns", ip: dst, host}, 600);
          }
        }
        return;
      }
    }

    if (record.ac === 'redirect') {
      if (dport == '123') record.type = 'ntp'
      await conntrack.setConnEntry(src, sport, dst, dport, record.pr, 'redirect', 1);
    }

    if (record.ac === "isolation") {
      record.isoGID = isolationTagId;
      record.isoLVL = isoLvl;
      dir = "L";
      ctdir = "O";
      if (isolationNetworkIdPrefix) {
        if (inIntf && _.isString(inIntf.uuid) && inIntf.uuid.startsWith(isolationNetworkIdPrefix))
          record.isoNID = inIntf.uuid;
        else {
          if (outIntf && _.isString(outIntf.uuid) && outIntf.uuid.startsWith(isolationNetworkIdPrefix))
            record.isoNID = outIntf.uuid;
        }
      }
    }

    if (security)
      record.sec = 1;
    if (tls)
      record.tls = 1;

    if ((dir === "L" || dir === "O" || dir === "I") && mark) {
      record.pid = Number(mark) & 0xffff;
    }
    if (record.ac === "route") {
      record.pid = Number(routeMark) & 0xffff; // route rule id
    }

    if (record.ac === "qos") {
      record.qmark = Number(mark) & 0x3fff000;
    }

    record.dir = dir;

    if (sysManager.isMulticastIP(dst, outIntf && outIntf.name || inIntf.name, false)) return

    switch (ctdir) {
      case undefined:
        if (record.ac !== 'redirect')
          throw new Error('Unrecognized ctdir in acl audit log');
        // fallsthrough
      case "O": {
        record.sh = src;
        record.dh = dst;
        record.sp = sport && [Number(sport)];
        record.dp = dport && Number(dport);
        break;
      }
      case "R": {
        record.sh = dst;
        record.dh = src;
        record.sp = dport && [Number(dport)];
        record.dp = sport && Number(sport);
        break;
      }
      default:
        log.error("Unrecognized ctdir in acl audit log", line);
        return;
    }

    const fam = net.isIP(record.dh)
    if (!fam) return

    // check direction, keep it same as flow.fd
    // in, initiated from inside, outbound
    // out, initiated from outside, inbound
    switch (dir) {
      case "O": {
        // outbound connection
        record.fd = "in";
        intf = ctdir === "O" || record.ac == 'redirect' ? inIntf : outIntf;
        localIP = record.sh;
        mac = ctdir === "O" || record.ac == 'redirect' ? srcMac : dstMac;
        break;
      }
      case "I": {
        // inbound connection
        record.fd = "out";
        intf = ctdir === "O" ? outIntf : inIntf;
        localIP = record.dh;
        mac = ctdir === "O" ? dstMac : srcMac;
        break;
      }
      case "L": {
        // local connection
        record.fd = ctdir === 'O' ? 'in' : 'out';
        intf = ctdir === "O" ? inIntf : outIntf;
        localIP = record.sh;
        mac = ctdir === "O" ? srcMac : dstMac;

        dIntf = ctdir === "O" ? outIntf : inIntf

        // resolve destination device mac address
        const dstHost = hostManager.getHostFast(record.dh, fam)
        if (dstHost) {
          record.dmac = dstHost.o.mac
        } else {
          const identity = IdentityManager.getIdentityByIP(record.dh);
          if (identity) {
            if (!platform.isFireRouterManaged())
              break;
            record.dmac = IdentityManager.getGUID(identity);
            record.drl = IdentityManager.getEndpointByIP(record.dh);
          }
        }
        break;
      }
      case "W": {
        // wan input connection
        record.fd = "out";
        intf = ctdir === "O" ? inIntf : outIntf;
        localIP = record.dh;
        mac = `${Constants.NS_INTERFACE}:${intf.uuid}`;
        break;
      }
      default:
        log.error("Unrecognized direction in acl audit log", line);
        return;
    }

    // use prefix to save memory
    if (intf) record.intf = intf.uuid.substring(0, 8);
    if (dIntf) record.dIntf = dIntf.uuid.substring(0, 8)
    if (wanUUID) record.wanIntf = wanUUID.startsWith(Constants.ACL_VPN_CLIENT_WAN_PREFIX) ? wanUUID : wanUUID.substring(0, 8);

    // ignores WAN block if there's recent connection to the same remote host & port
    // this solves issue when packets come after local conntrack times out
    if (record.fd === "out" && record.sp && conntrack.getConnRemote(record.pr, record.sh, record.sp[0])) return;

    if (!localIP) {
      log.error('No local IP', line);
      return;
    }

    // broadcast mac address
    if (mac == 'FF:FF:FF:FF:FF:FF') return

    if (dir !== "W" && !mac) { // no need to lookup identity for WAN input connection
      const identity = IdentityManager.getIdentityByIP(localIP);
      if (identity) {
        if (!platform.isFireRouterManaged())
          return;
        mac = IdentityManager.getGUID(identity);
        record.rl = IdentityManager.getEndpointByIP(localIP);
      }
    }
    // maybe from a non-ethernet network, or dst mac is self mac address
    if (!mac || sysManager.isMyMac(mac)) {
      mac = await hostTool.getMacByIPWithCache(localIP)
        || intf && `${Constants.NS_INTERFACE}:${intf.uuid}`
    }
    // mac != intf.mac_address => mac is device mac, keep mac unchanged

    if (!mac) {
      log.warn('MAC address not found for', localIP)
      return
    }

    record.mac = mac

    // try to get host name from conn entries for better timeliness and accuracy
    if (dir === "O" && record.ac === "block") {
      // delay 5 seconds to process outbound block flow, in case ssl/http host is available in zeek's ssl log and will be saved into conn entries
      let t = 5
      // if flow is blocked by tls kernel module and zeek listens on bridge, zeek won't see the tcp RST packet due to br_netfilter. This introduces another 20 seconds before ssl/http log is generated
      if (record.pr == "tcp" && (record.dp === 443 || record.dp === 80) && this.isPcapOnBridge(inIntf))
        t += 20;
      await delay(t * 1000);
      let connEntries = await conntrack.getConnEntries(record.sh, record.sp[0], record.dh, record.dp, record.pr, 600);

      if (!connEntries || !connEntries.host) {
        if (this.isDNATedOnBridge(inIntf)) {
          await delay(10000)
        }
        connEntries = await conntrack.getConnEntries(mac, "", record.dh, "", "dns", 600);
      }

      if (connEntries && connEntries.host) {
        record.af = {};
        record.af[connEntries.host] = _.pick(connEntries, ["proto", "ip"])
      }
    }

    // record route rule id
    if (record.pid && record.ac === "route") {
      await conntrack.setConnEntry(record.sh, record.sp[0], record.dh, record.dp, record.pr, Constants.REDIS_HKEY_CONN_RPID, record.pid, 600);
    }

    // record allow rule id
    if (record.pid && record.ac === "allow") {
      await conntrack.setConnEntry(record.sh, record.sp[0], record.dh, record.dp, record.pr, Constants.REDIS_HKEY_CONN_APID, record.pid, 600);
    }

    this.writeBuffer(record);
    // local block
    const reverseRecord = this.getReverseRecord(record);
    if (reverseRecord)
      this.writeBuffer(reverseRecord);
  }

  getReverseRecord(record) {
    if (record.dmac) { // only record the reverse direction when distination device exists
      const reverseRecord = JSON.parse(JSON.stringify(record))
      reverseRecord.mac = record.dmac
      reverseRecord.dmac = record.mac
      reverseRecord.intf = record.dIntf
      reverseRecord.dIntf = record.intf
      if (record.rl)
        reverseRecord.drl = record.rl
      else
        delete reverseRecord.drl
      if (record.drl)
        reverseRecord.rl = record.drl
      else
        delete reverseRecord.rl
      reverseRecord.fd = record.fd == 'in' ? 'out' : 'in'
      return reverseRecord;
    }
    return null;
  }

  async _processDnsRecord(record) {
    record.type = 'dns'
    record.pr = 'dns'

    if (!record.dn ||
      record.ac == 'allow' &&
        (record.dn.endsWith('.arpa') || sysManager.isLocalDomain(record.dn) || sysManager.isSearchDomain(record.dn))
    ) return

    // in dnsmasq log, policy id of -1 means global domain or ip rules that we need to analyze further.
    if (record.pid === -1) {
      record.global = true;
      record.pid = 0;
    }

    let intfUUID = null;
    const intf = sysManager.getInterfaceViaIP(record.sh);
    if (intf) {
      intfUUID = intf.uuid;
      if (record.sh == intf.ip_address) return
    }

    let mac = record.mac;
    // first try to get mac from device database
    if (!mac || mac === "FF:FF:FF:FF:FF:FF") {
      mac = null;
      if (record.sh) {
        if (net.isIPv4(record.sh)) {
          // very likely this is a VPN device
          const identity = IdentityManager.getIdentityByIP(record.sh);
          if (identity) {
            if (!platform.isFireRouterManaged())
              return;
            mac = IdentityManager.getGUID(identity);
            record.rl = IdentityManager.getEndpointByIP(record.sh);
            if (!intfUUID) // in rare cases, client is from another box's local network in the same VPN mesh, source IP is not SNATed
              intfUUID = identity.getNicUUID();
          }
        }
        if (!mac) {
          if (intfUUID || record.sh.startsWith("fe80"))
            mac = await hostTool.getMacByIPWithCache(record.sh);
          else // ignore src IP out of local networks
            return;
        }
      }
    }
    if (mac && sysManager.isMyMac(mac)) return

    if (!intfUUID) {
      if (mac && hostTool.isMacAddress(mac)) {
        // if device is using link-local IPv6 address to query box's DNS server on link-local address, getInterfaceViaIP won't work
        const host = hostManager.getHostFastByMAC(mac);
        if (host && host.o.intf)
          intfUUID = host.o.intf;
      }
      if (!intfUUID) {
        log.debug('Interface not found for', record.sh);
        return null
      }
    }

    record.intf = intfUUID.substring(0, 8);

    if (!mac) {
      log.verbose('MAC address not found for', record.sh || JSON.stringify(record))
      return
    }

    record.ct = record.ct || 1;

    this.writeBuffer(record);
  }

  // line example
  // [Blocked]ts=1620435648 mac=68:54:5a:68:e4:30 sh=192.168.154.168 sh6= dn=hometwn-device-api.coro.net
  // [Blocked]ts=1620435648 mac=68:54:5a:68:e4:30 sh= sh6=2001::1234:0:0:567:ff dn=hometwn-device-api.coro.net
  async _processDnsmasqLog(line) {
    if (line) {
      let recordArr;
      const record = {};
      record.dp = 53;

      const iBlocked = line.indexOf('[Blocked]')
      if (iBlocked >= 0) {
        recordArr = line.substr(iBlocked + 9).split(' ');
        record.rc = 3; // dns block's return code is 3
        record.ac = "block";
      } else if (fc.isFeatureOn("dnsmasq_log_allow")) {
        const iAllowed = line.indexOf('[Allowed]')
        if (iAllowed >= 0) {
          record.ac = "allow";
          recordArr = line.substr(iAllowed + 9).split(' ');
        }
      }
      if (!recordArr || !Array.isArray(recordArr)) return;

      // syslogd feature, repeated messages will be reduced to 1 line as "message repeated x times: [ <msg> ]"
      // https://www.rsyslog.com/doc/master/configuration/action/rsconf1_repeatedmsgreduction.html
      const iRepeatd = line.indexOf('message repeated')
      if (iRepeatd >= 0) {
        const iTimes = line.indexOf('times:', iRepeatd)
        if (iTimes < 0) log.error('Malformed repeating info', line)

        record.ct = Number(line.substring(iRepeatd + 16, iTimes))

        const str = recordArr.pop()
        recordArr.push(str.slice(0, -1))
      }

      for (const param of recordArr) {
        const kv = param.split("=")
        if (kv.length != 2) continue;
        const k = kv[0]; const v = kv[1];
        if (!_.isEmpty(v)) {
          switch (k) {
            case "ts":
              record.ts = Number(v);
              break;
            case "mac":
              record.mac = v.toUpperCase();
              break;
            case "sh":
              record.sh = v;
              record.qt = 1;
              break;
            case "sh6":
              record.sh = v;
              record.qt = 28;
              break;
            case "dn":
              record.dn = v.toLowerCase();
              break;
            case "lbl":
              if (v && v.startsWith("policy_") && !isNaN(v.substring(7))) {
                if (!record.pid) {
                  record.pid = Number(v.substring(7));
                }
              } else {
                const reason = labelReasonMap[v];
                if (reason)
                  record.reason = reason;
              }
              if (v === "global_acl_high") {
                record.sec = 1;
              }
              break;
            case "pid":
              record.pid = Number(v);
              break;
            default:
          }
        }
      }
      record._ts = getUniqueTs(record.ts || Date.now()/1000)
      this._processDnsRecord(record);
    }
  }

  _getAuditKey(record, block) {
    const { mac, dir } = record
    return `audit:${dir=='L'?'local:':''}${block?'drop':'accept'}:${mac}`
  }

  async writeLogs() {
    try {
      // log.debug('Start writing logs')
      // log.debug(JSON.stringify(this.buffer))

      const buffer = this.buffer
      this.buffer = {}
      // log.debug(buffer)

      for (const mac in buffer) {
        const multi = rclient.multi()
        for (const descriptor in buffer[mac]) {
          const record = buffer[mac][descriptor];
          const { type, ac, _ts, ct, fd, dir } = record
          const intf = record.intf && networkProfileManager.prefixMap[record.intf]
          const block = record.ac == "block" || record.ac == "isolation";

          // pid backtrace
          if (type != 'ntp') { // ntp has nothing to do with rules
            if (!record.pid && (type == 'dns' || ac == 'block' || ac == 'allow')) {
              const matchedPIDs = await this.ruleStatsPlugin.getMatchedPids(record);
              if (matchedPIDs && matchedPIDs.length > 0){
                record.pid = matchedPIDs[0];
              }
            }

            if (type == 'ip' || record.ac == 'block')
              this.ruleStatsPlugin.accountRule(record);
          }

          if (type == 'ip' && record.ac != "block" && record.ac != 'redirect' && record.ac != "isolation")
            continue

          let monitorable = IdentityManager.getIdentityByGUID(mac);
          if (!monitorable && !mac.startsWith(Constants.NS_INTERFACE + ':')) {
            monitorable = hostManager.getHostFastByMAC(mac);
          }
          const tags = await hostTool.getTags(monitorable, intf)
          if (monitorable) Object.assign(record, tags)

          if (record.dir == 'L') {
            if (record.dmac) {
              let dstMonitorable = IdentityManager.getIdentityByGUID(record.dmac);
              if (!dstMonitorable && !record.dmac.startsWith(Constants.NS_INTERFACE + ':')) {
                dstMonitorable = hostManager.getHostFastByMAC(record.dmac);
              }
              if (dstMonitorable) {
                const dstTags = await hostTool.getTags(dstMonitorable, intf)
                if (Object.keys(dstTags).length) record.dstTags = dstTags
              }
            }
            if (record.ac == "isolation") {
              switch (record.isoLVL) {
                case 1: {
                  if (monitorable) {
                    const isoPolicy = monitorable.getPolicyFast("isolation");
                    record.isoHost = _.get(isoPolicy, "external") ? "sh" : "dh"; // indicate whether the isolation is applied on source host or dest host
                  }
                  break;
                }
                case 3: {
                  if (record.isoGID && !_.has(record, "isoInt") && !_.has(record, "isoExt")) {
                    const tag = TagManager.getTagByUid(record.isoGID);
                    if (tag) {
                      const tagIsoPolicy = tag.getPolicyFast("isolation");
                      record.isoInt = _.get(tagIsoPolicy, "internal") || false;
                      record.isoExt = _.get(tagIsoPolicy, "external") || false;
                    }
                  }
                  break;
                }
              }
            }

            const hitType = type + (block ? 'B' : '')
            timeSeries.recordHit(`${hitType}:lo:intra`, _ts, ct)
            timeSeries.recordHit(`${hitType}:lo:${fd}:${mac}`, _ts, ct)
            if (intf && record.dIntf == record.intf) {
              timeSeries.recordHit(`${hitType}:lo:intra:intf:${intf}`, _ts, ct)
            } else {
              timeSeries.recordHit(`${hitType}:lo:${fd}:intf:${intf}`, _ts, ct)
            }
            for (const key in tags) {
              for (const tag of tags[key]) {
                if (_.get(record, ['dstTags',key], []).includes(tag)) {
                  timeSeries.recordHit(`${hitType}:lo:intra:tag:${tag}`, _ts, ct)
                } else {
                  timeSeries.recordHit(`${hitType}:lo:${fd}:tag:${tag}`, _ts, ct)
                }
              }
            }
          } else // use dns_flow as a prioirty for statistics
            if (type != 'dns' || block || !platform.isDNSFlowSupported() || !fc.isFeatureOn('dns_flow')) {
              const hitType = type + (block ? 'B' : '')
              timeSeries.recordHit(`${hitType}`, _ts, ct)
              timeSeries.recordHit(`${hitType}:${mac}`, _ts, ct)
              if (intf) timeSeries.recordHit(`${hitType}:intf:${intf}`, _ts, ct)
              for (const key in tags) {
                for (const tag of tags[key]) {
                  timeSeries.recordHit(`${hitType}:tag:${tag}`, _ts, ct)
                }
              }
            }


          // use a dedicated switch for saving to audit:accpet as we still want rule stats
          if (type == 'dns' && !block && !fc.isFeatureOn('dnsmasq_log_allow_redis')) continue

          const key = this._getAuditKey(record, block)

          delete record.dir
          delete record.mac
          multi.zadd(key, _ts, JSON.stringify(record));
          if (!mac.startsWith(Constants.NS_INTERFACE + ":"))
            multi.zadd("deviceLastFlowTs", _ts, mac);
          this.touchedKeys[key] = 1;
          // no need to set ttl here, OldDataCleanSensor will take care of it

          block && sem.emitLocalEvent({
            type: "Flow2Stream",
            suppressEventLogging: true,
            raw: Object.assign({}, record, { mac }), // record the mac address here
            audit: true,
            ftype: mac.startsWith(Constants.NS_INTERFACE + ':') ? "wanBlock" : "normal"
          })
          // audit block event stream that will be consumed by FlowAggregationSensor
          block && sem.emitLocalEvent({
            type: Message.MSG_FLOW_ACL_AUDIT_BLOCKED,
            suppressEventLogging: true,
            flow: Object.assign({}, record, {mac, _ts, intf, dir})
          });
        }
        await multi.execAsync()
      }
      timeSeries.exec()
    } catch (err) {
      log.error("Failed to write audit logs", err)
    }
  }

  // Works similar to flowStash in BroDetect, reduce memory is the main purpose here
  async mergeLogs(startOpt, endOpt) {
    try {
      // merge 1 interval (default 5min) before to make sure it doesn't affect FlowAggregationSensor
      const end = endOpt || Math.floor(Date.now() / 1000 / this.config.interval - 1) * this.config.interval
      const start = startOpt || end - this.config.interval
      log.debug('Start merging', start, end)
      const auditKeys = Object.keys(this.touchedKeys);
      this.touchedKeys = {};
      log.debug('Key(mac) count: ', auditKeys.length)
      for (const key of auditKeys) {
        const records = await rclient.zrangebyscoreAsync(key, '('+start, end)
        // const mac = key.substring(11) // audit:drop:<mac>

        const stash = {}
        for (const recordString of records) {
          try {
            const record = JSON.parse(recordString)
            const descriptor = this.getDescriptor(record)

            if (stash[descriptor]) {
              const s = stash[descriptor]
              // _.min() and _.max() will ignore non-number values
              s.ts = _.min([s.ts, record.ts])
              s._ts = _.max([s._ts, record._ts])
              s.du = Math.round((_.max([s.ts + (s.du || 0), record.ts + (record.du || 0)]) - s.ts) * 100) / 100
              s.ct += record.ct
              if (s.sp) s.sp = _.uniq(s.sp, record.sp)
            } else {
              stash[descriptor] = record
            }
          } catch (err) {
            log.error('Failed to process record', err, recordString)
          }
        }

        const transaction = [];
        transaction.push(['zremrangebyscore', key, '('+start, end]);
        for (const descriptor in stash) {
          const record = stash[descriptor]
          transaction.push(['zadd', key, record._ts, JSON.stringify(record)])
        }
        // no need to set ttl here, OldDataCleanSensor will take care of it

        // catch this to proceed onto the next iteration
        try {
          log.debug(transaction)
          await rclient.pipelineAndLog(transaction)
          log.debug("Audit:Save:Aggregated", key);
        } catch (err) {
          log.error("Audit:Save:Error", err);
        }
      }


    } catch (err) {
      log.error("Failed to merge audit logs", err)
    }
  }

  async globalOn() {
    super.globalOn()

    await exec(`${f.getFirewallaHome()}/scripts/audit-run`)

    this.bufferDumper = this.bufferDumper || setInterval(this.writeLogs.bind(this), (this.config.buffer || 30) * 1000)
    this.aggregator = this.aggregator || setInterval(this.mergeLogs.bind(this), (this.config.interval || 300) * 1000)

    await exec(`${f.getFirewallaHome()}/scripts/dnsmasq-log on`);
  }

  async globalOff() {
    super.globalOff()

    await exec(`${f.getFirewallaHome()}/scripts/audit-stop`)

    clearInterval(this.bufferDumper)
    clearInterval(this.aggregator)
    this.bufferDumper = this.aggregator = undefined

    await exec(`${f.getFirewallaHome()}/scripts/dnsmasq-log off`);
  }
}

module.exports = ACLAuditLogPlugin;
