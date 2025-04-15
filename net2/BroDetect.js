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

const log = require('./logger.js')(__filename);

const LogReader = require('../util/LogReader.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const ipUtil = require("../util/IPUtil.js");

const sysManager = require('./SysManager.js');
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const flowTool = require('./FlowTool.js')
const conntrack = require('../net2/Conntrack.js')

const broNotice = require('../extension/bro/BroNotice.js');

const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();
const Identity = require('./Identity.js')
const IdentityManager = require('./IdentityManager.js');
const Monitorable = require('./Monitorable')
const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()
const IntelTool = require('./IntelTool.js')
const intelTool = new IntelTool()

const Accounting = require('../control/Accounting.js');
const accounting = new Accounting();

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const firewalla = require('../net2/Firewalla.js');
const Message = require('../net2/Message.js');

const mode = require('../net2/Mode.js')

const linux = require('../util/linux.js');

const l2 = require('../util/Layer2.js');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const timeSeries = require("../util/TimeSeries.js").getTimeSeries()

const sem = require('../sensor/SensorEventManager.js').getInstance();
const fc = require('../net2/config.js')
const config = fc.getConfig().bro

const APP_MAP_SIZE = 1000;
const SIG_MAP_SIZE = 1000;
const PROXY_CONN_SIZE = 100;
const DNS_CACHE_SIZE = 100;

const httpFlow = require('../extension/flow/HttpFlow.js');
const NetworkProfileManager = require('./NetworkProfileManager.js')
const _ = require('lodash');
const fsp = require('fs').promises;

const {formulateHostname, isDomainValid, delay} = require('../util/util.js');
const { getUniqueTs } = require('./FlowUtil.js')

const LRU = require('lru-cache');
const Constants = require('./Constants.js');

const TYPE_MAC = "mac";
const TYPE_VPN = "vpn";

/*
 *
 *  config.bro.notice.path {
 *  config.bro.intel.path {
 *
 *  config.bro.notice.monitor {
 *      'type':'action'
 *  }
 *
 * {"ts":1463726594.405281,"note":"Scan::Port_Scan","msg":"192.168.2.153 scanned at least 15 unique ports of host 192.168.2.111 in 0m0s","sub":"local","src":"192.168.2.153","dst":"192.168.2.111","peer_descr":"bro","actions":["Notice::ACTION_LOG"],"suppress_for":3600.0,"dropped":false}
 *
 * x509
{"ts":1464811516.502757,"id":"F1zrEA4jvTA90H5uVc","certificate.version":3,"certificate.serial":"053FCE9BA6805B00","certificate.subject":"C=US,ST=California,O=Apple
 Inc.,OU=management:idms.group.506364,CN=*.icloud.com","certificate.issuer":"C=US,O=Apple Inc.,OU=Certification Authority,CN=Apple IST CA 2 - G1","certificate.not_
valid_before":1424184331.0,"certificate.not_valid_after":1489848331.0,"certificate.key_alg":"rsaEncryption","certificate.sig_alg":"sha256WithRSAEncryption","certif
icate.key_type":"rsa","certificate.key_length":2048,"certificate.exponent":"65537","san.dns":["*.icloud.com"],"basic_constraints.ca":false}

{"ts":1473403205.383678,"uid":"CKyWkpbu7tXTHyoLd","id.orig_h":"192.168.2.225","id.orig_p":51020,"id.resp_h":"52.89.107.175","id.resp_p":443,"version":"TLSv12","cipher":"TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256","server_name":"firewalla.encipher.io","resumed":true,"established":true}


{"ts":1473403304.343692,"uid":"CUErnP2cnw0z5Ilj07","id.orig_h":"192.168.2.221","id.orig_p":64096,"id.resp_h":"203.205.179.152","id.resp_p":80,"trans_depth":1,"method":"POST","host":"caminorshort.weixin.qq.com","uri":"/mmtls/32fc51a3","user_agent":"MicroMessenger Client","request_body_len":537,"response_body_len":226,"status_code":200,"status_msg":"OK","tags":[],"orig_fuids":["FMcFnE1TMNpElbp7Ce"],"resp_fuids":["FG0eXV2blQRAslCcOg"]}

 *
 */

function ValidateIPaddress(ipaddress) {
  if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
    return (true)
  }
  return (false)
}

class BroDetect {

  initWatchers() {
    const watchers = {
      "intelLog": [config.intel.path, this.processIntelData],
      "noticeLog": [config.notice.path, this.processNoticeData],
      "dnsLog": [config.dns.path, this.processDnsData],
      "httpLog": [config.http.path, this.processHttpData],
      "sslLog": [config.ssl.path, this.processSslData],
      "connLog": [config.conn.path, this.processConnData, 2000], // wait 2 seconds for appmap population
      "connLongLog": [config.connLong.path, this.processLongConnData],
      "connLogDev": [config.conn.pathdev, this.processConnData],
      "x509Log": [config.x509.path, this.processX509Data],
      "knownHostsLog": [config.knownHosts.path, this.processknownHostsData],
      "signatureLog": [config.signature.path, this.processSignatureData],
    };

    for(const watcher in watchers) {
      const [file, func, delayMs] = watchers[watcher];
      this[watcher] = new LogReader(file, false, delayMs);
      this[watcher].on('line', func.bind(this));
      this[watcher].watch();
    }
  }

  constructor() {
    log.info('Initializing BroDetect')
    if (!firewalla.isMain())
      return;
    this.appmap = new LRU({max: APP_MAP_SIZE, maxAge: 10800 * 1000});
    this.sigmap = new LRU({max: SIG_MAP_SIZE, maxAge: 10800 * 1000});
    this.proxyConn = new LRU({max: PROXY_CONN_SIZE, maxAge: 60 * 1000});
    this.dnsCache = new LRU({max: DNS_CACHE_SIZE, maxAge: 3600 * 1000});
    this.dnsCount = 0
    this.dnsHit = 0
    this.dnsMatch = 0
    this.outportarray = [];

    let c = require('./MessageBus.js');
    this.publisher = new c();

    this.flowstash = { conn: {}, dns: {} }
    this.lastRotate = { conn: Date.now() / 1000, dns: Date.now() / 1000 }
    this.rotateFlowstashTask = {}
    this.rotateFlowstashTask.conn = setInterval(() => {
      this.rotateFlowStash('conn')
    }, config.conn.flowstashExpires * 1000)
    // stagger 2 flow stashes to flat redis IO
    setTimeout(() => {
      this.rotateFlowStash('dns')
      this.rotateFlowstashTask.dns = setInterval(() => {
        this.rotateFlowStash('dns')
      }, config.dns.flowstashExpires * 1000)
    }, config.dns.flowstashExpires * 1000 / 2)

    this.activeMac = {};
    this.incTs = 0;

    setInterval(() => {
      this._activeMacHeartbeat();
    }, 60000);

    this.timeSeriesCache = { }
    this.tsWriteInterval = config.conn.tsWriteInterval || 10000
    this.recordTrafficTask = setInterval(() => {
      this.writeTrafficCache().catch(err => {
        log.error('Error writing timeseries', err)
      })
    }, this.tsWriteInterval)

    this.activeLongConns = new Map();
    setInterval(() => {
      const now = Date.now() / 1000
      const connCount = this.activeLongConns.size
      if (connCount > 1000)
        log.warn('Active long conn:', connCount);
      else if (connCount > 500)
        log.info('Active long conn:', connCount);
      else
        log.debug('Active long conn:', connCount);
      for (const uid of this.activeLongConns.keys()) {
        const lastTick = this.activeLongConns.get(uid).ts + this.activeLongConns.get(uid).duration
        if (lastTick + config.connLong.expires < now)
          this.activeLongConns.delete(uid)
      }
    }, 60 * 1000)
  }

  async _activeMacHeartbeat() {
    for (let mac in this.activeMac) {
      let entry = this.activeMac[mac];
      let host = {
        mac: mac,
        from: "macHeartbeat"
      };
      if (entry.ipv4Addr && net.isIPv4(entry.ipv4Addr)) {
        host.ipv4 = entry.ipv4Addr;
        host.ipv4Addr = entry.ipv4Addr;
      }
      if (entry.ipv6Addr && Array.isArray(entry.ipv6Addr) && entry.ipv6Addr.length > 0) {
        host.ipv6Addr = entry.ipv6Addr;
      }
      if (host.ipv4Addr || host.ipv6Addr) {
        const intfInfo = host.ipv4Addr ? sysManager.getInterfaceViaIP4(host.ipv4Addr) : host.ipv6Addr.map(ip6 => sysManager.getInterfaceViaIP6(ip6)).find(i => i);
        if (!intfInfo || !intfInfo.uuid) {
          log.error(`HeartBeat: Unable to find nif uuid, ${host.ipv4Addr}, ${mac}`);
          continue;
        }
        sem.emitEvent({
          type: "DeviceUpdate",
          message: `Device network activity heartbeat ${host.ipv4Addr || host.ipv6Addr} ${host.mac}`,
          host,
          suppressEventLogging: true
        });
      }
    }
    if (firewalla.isDevelopmentVersion()) {
      if (await sysManager.isBridgeMode()) {
        // probably need to add permanent ARP entries to arp table in bridge mode
        await l2.updatePermanentArpEntries(this.activeMac);
      }
    }
    this.activeMac = {};
  }

  async start() {
    if (firewalla.isMain()) {
      this.initWatchers();
      this.wanNicStatsCache = await this.getWanNicStats();
      sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
        this.wanNicStatsCache = await this.getWanNicStats();
      });
    }
  }

  depositeAppMap(src, sport, dst, dport, value) {
    if (ValidateIPaddress(value.host)) {
      return;
    }

    if (sysManager.isOurCloudServer(value.host)) {
      return;
    }
    const key = `${src}:${sport}:${dst}:${dport}`;
    this.appmap.set(key, value);
  }

  withdrawAppMap(src, sport, dst, dport, preserve = false) {
    const key = `${src}:${sport}:${dst}:${dport}`;
    let obj = this.appmap.get(key);
    if (obj && !preserve) {
      this.appmap.del(key);
    }
    return obj;
  }

  addConnSignature(uid, sigId) {
    if (!this.sigmap.has(uid))
      this.sigmap.set(uid, {});
    this.sigmap.get(uid)[sigId] = 1;
  }

  getConnSignatures(uid) {
    if (!this.sigmap.has(uid) || !_.isObject(this.sigmap.get(uid)))
      return null;
    return Object.keys(this.sigmap.get(uid));
  }

  extractIP(str) {
    // since zeek 5.0, the host will contain port number if it is not a well-known port
    // http connect might contain target port (not the same as id.resp_p which is proxy port
    // and sometimes there's a single trailing ':', probably a zeek bug
    // v6 ip address is wrapped with []
    if (str.includes(']:')) {
      // only removes port and trailing : here
      str = str.substring(0, str.indexOf(']:') + 1)
    }
    if (str.startsWith("[") && str.endsWith("]")) {
      // strip [] from an ipv6 address
      str = str.substring(1, str.length - 1);
    }

    // remove tailing port of v4 addresses
    if (str.includes(':') && net.isIP(str) != 6) {
      str = str.substring(0, str.indexOf(':'))
    }

    return str
  }

  async processHttpData(data) {
    try {
      const obj = JSON.parse(data);

      const ip = obj['id.resp_h']

      let host = obj.host
      if (host) {
        // workaround for https://github.com/zeek/zeek/issues/1844
        if (host.match(/^\[?[0-9a-e]{1,4}$/)) {
          host = ip || ''
        }

        host = this.extractIP(host)
        obj.host = host
      }

      // HTTP proxy, drop host info
      if (obj.method == 'CONNECT' || obj.proxied) {
        this.proxyConn.set(obj.uid, true)
        log.verbose('Drop HTTP CONNECT', host, obj)

        // in case SSL record processed already

        // HTTP & SSL functions might still run into racing condition
        // adding a lock doesn't really worth the performance penalty, simply adds a delay here
        await delay((config.http.proxyIntelRemoveDelay || 30) * 1000)

        // remove af data from flowstash
        // won't be querying redis for written flows here as the cost is probably too much for this feature
        for (const key in this.flowstash.conn) {
          if (this.flowstash.conn[key].uids.includes(obj.uid)) {
            const af = this.flowstash.conn[key].af
            if (af[host] && af[host].ip == ip)
              delete af[host]
            break // one uid could only appear in one flow
          }
        }

        this.withdrawAppMap(obj['id.orig_h'], obj['id.orig_p'], ip, obj['id.resp_p']);
        await conntrack.delConnEntries(obj['id.orig_h'], obj['id.orig_p'], ip, obj['id.resp_p'], 'tcp');

        await rclient.unlinkAsync(intelTool.getSSLCertKey(ip))

        await dnsTool.removeReverseDns(host, ip);
        await dnsTool.removeDns(ip, host);

        // DestIPFoundHook might have added intel:ip before everything get reversed
        const intel = await intelTool.getIntel(ip)
        if (intel && (intel.host == host || intel.sslHost == host || intel.dnsHost == host)) {
          delete intel.host
          delete intel.sslHost
          delete intel.dnsHost
          delete intel.category

          // remove domain related info and but keep the stub data to prevent rapid cloud fetch
          await intelTool.removeIntel(ip)
          await intelTool.addIntel(ip, intel)
        }

        return
      }

      httpFlow.process(obj);
      const appCacheObj = {
        uid: obj.uid,
        host: host,
        proto: "http",
        ip: obj["id.resp_h"]
      };
      // this data can be used across processes, e.g., live flows in FireAPI
      if (appCacheObj.host && obj["id.orig_h"] && obj["id.resp_h"] && obj["id.orig_p"] && obj["id.resp_p"]) {
        const data = {};
        data[Constants.REDIS_HKEY_CONN_HOST] = appCacheObj.host;
        data.proto = "http";
        data.ip = obj["id.resp_h"];
        await conntrack.setConnEntries(obj["id.orig_h"], obj["id.orig_p"], obj["id.resp_h"], obj["id.resp_p"], "tcp", data, 600);
        this.depositeAppMap(obj["id.orig_h"], obj["id.orig_p"], obj["id.resp_h"], obj["id.resp_p"], appCacheObj);
      }
    } catch (err) {
      log.error("Processing HTTP data", err, data);
    }
  }

  /*
    {"ts":1464244116.539545,"uid":"CwMpfX2Ya0NkxBCqbe","id.orig_h":"192.168.2.221","id.orig_p":58937,"id.resp_h":"199.27.79.143","id.resp_p":443,"fuid":"FmjEXV3czWtY9ykTG8","file_mime_type":"application/pkix-cert","file_desc":"199.27.79.143:443/tcp","seen.indicator":"forms.aweber.com","seen.indicator_type":"Intel::DOMAIN","seen.where":"X509::IN_CERT","seen.node":"bro","sources":["from http://hosts-file.net/psh.txt via intel.criticalstack.com"]}
    */

  processIntelData(data) {
    try {
      let obj = JSON.parse(data);
      log.info("Intel:New", data, obj);
      if (obj['id.orig_h'] == null) {
        log.error("Intel:Drop", obj);
        return;
      }
      if (config.intel.ignore[obj.note] == null) {
        let strdata = JSON.stringify(obj);
        let key = "intel:" + obj['id.orig_h'];
        let redisObj = [key, obj.ts, strdata];
        log.debug("Intel:Save", redisObj);
        rclient.zadd(redisObj, (err, response) => {
          if (err) {
            log.error("Intel:Save:Error", err);
          } else {
            if (config.intel.expires) {
              rclient.expireat(key, parseInt((+new Date) / 1000) + config.intel.expires);
            }
            this.publisher.publish("DiscoveryEvent", "Intel:Detected", obj['id.orig_h'], obj);
            this.publisher.publish("DiscoveryEvent", "Intel:Detected", obj['id.resp_h'], obj);
          }
        });
      } else {
        log.debug("Intel:Drop", JSON.parse(data));
      }
    } catch (e) {
      log.error("Intel:Error Unable to save", e, e.stack, data);
    }
  }

  isIdentityLAN(intfInfo) {
    return intfInfo && intfInfo.name && (intfInfo.name == "tun_fwvpn" || intfInfo.name.startsWith("wg"))
  }

  recordDeviceHeartbeat(mac, ts, ip, fam = 4) {
    // do not record into activeMac if it is earlier than 5 minutes ago, in case the IP address has changed in the last 5 minutes
    if (ts > Date.now() / 1000 - 300) {
      let macIPEntry = this.activeMac[mac];
      if (!macIPEntry)
        macIPEntry = { ipv6Addr: [] };
      if (fam == 4) {
        macIPEntry.ipv4Addr = ip;
      } else if (fam == 6) {
        macIPEntry.ipv6Addr.push(ip);
      }
      this.activeMac[mac] = macIPEntry;
    }
  }

  async saveDNSFlow(obj) {
    if (platform.isDNSFlowSupported() && fc.isFeatureOn('dns_flow')) try {
      const now = Date.now() / 1000
      const dnsFlow = {
        ts: Math.round((obj.ts) * 100) / 100,
        _ts: getUniqueTs(now), // _ts is the last time updated, make it unique to avoid missing flows in time-based query
        dn: obj.query,
        sh: obj["id.orig_h"],
        dh: obj["id.resp_h"],
        dp: obj["id.resp_p"],
        as: obj.answers,
        ct: 1,
      }

      // save only A & AAAA requests for now, qtype might be missing
      if (obj.qtype && obj.qtype != 1 && obj.qtype != 28) return

      if (obj.query.endsWith('.arpa')) return

      const localFam = net.isIP(dnsFlow.sh)
      if (!localFam) {
        log.error('Dns:Error:Drop Invalid source IP', dnsFlow.sh)
        return
      }

      let localMac = obj.orig_l2_addr && obj.orig_l2_addr.toUpperCase()
      let monitorable

      let intfInfo = sysManager.getInterfaceViaIP(dnsFlow.sh);
      const isIdentityIntf = this.isIdentityLAN(intfInfo)

      if (localFam == 4 && sysManager.isMyIP(dnsFlow.sh) ||
        localFam == 6 && sysManager.isMyIP6(dnsFlow.sh)) {
        return
      }

      if (!localMac) {
        if (isIdentityIntf)
          monitorable = await this.waitAndGetIdentity(dnsFlow.sh)
        if (monitorable) {
          localMac = IdentityManager.getGUID(monitorable);
          dnsFlow.rl = IdentityManager.getEndpointByIP(dnsFlow.sh);
          if (!intfInfo)
            intfInfo = monitorable.getNicName() && sysManager.getInterface(monitorable.getNicName());
        }
      } else {
        if (sysManager.isMyMac(localMac)) {
          log.debug("Discard incorrect local MAC from DNS log: ", localMac, dnsFlow.sh);
          localMac = null
        }

        monitorable = hostManager.getHostFastByMAC(localMac);
        if (!monitorable) {
          if (localFam == 4) {
            monitorable = hostManager.getHostFast(dnsFlow.sh);
          } else if (localFam == 6) {
            monitorable = hostManager.getHostFast6(dnsFlow.sh);
          }
        }

        this.recordDeviceHeartbeat(localMac, dnsFlow.ts, dnsFlow.sh, localFam)
      }

      if (!this.isMonitoring(intfInfo, monitorable) || !this.isDNSCacheOn(intfInfo, monitorable)) {
        return;
      }

      if (!localMac && !isIdentityIntf) {
        localMac = await hostTool.getMacByIPWithCache(dnsFlow.sh)
      }

      if (!localMac || localMac.constructor.name !== "String") {
        log.verbose('NO LOCAL MAC! Drop DNS', JSON.stringify(obj))
        return
      }

      const tags = await hostTool.getTags(monitorable, intfInfo && intfInfo.uuid)

      this.recordTraffic({ dns: 1 }, localMac);
      this.recordTraffic({ dns: 1 }, 'global');
      if (intfInfo) {
        this.recordTraffic({ dns: 1 }, 'intf:' + intfInfo.uuid);
      }
      for (const key in tags) {
        dnsFlow[key] = tags[key]
        for (const tag of tags[key]) {
          this.recordTraffic({ dns: 1 }, 'tag:' + tag);
        }
      }

      let key = "flow:dns:" + localMac;
      await rclient.zaddAsync(key, dnsFlow._ts, JSON.stringify(dnsFlow)).catch(
        err => log.error("Failed to save single DNS flow: ", dnsFlow, err)
      )

      const flowspecKey = `${localMac}:${dnsFlow.dn}:${intfInfo ? intfInfo.uuid : ''}`;
      // add keys to flowstash (but not redis)
      dnsFlow.mac = localMac
      Object.assign(dnsFlow, tags)

      let flowspec = this.flowstash.dns[flowspecKey];
      if (flowspec == null) {
        flowspec = dnsFlow
        this.flowstash.dns[flowspecKey] = flowspec;
      } else {
        flowspec.ct += 1;
        if (flowspec.ts > dnsFlow.ts) {
          // update start timestamp
          flowspec.ts = dnsFlow.ts;
        }
        // update last time updated
        flowspec._ts = Math.max(flowspec._ts, dnsFlow._ts);

        flowspec.as = _.union(flowspec.as, dnsFlow.as)
      }

    } catch(err) {
      log.error('Error saving DNS flow', JSON.stringify(obj), err)
    }
  }

  async processDnsData(data) {
    let obj = JSON.parse(data);
    if (obj == null || obj["id.resp_p"] != 53) {
      return;
    }
    if (obj.answers && obj.answers.length)
      obj.answers = obj.answers.filter(a => !a.startsWith('<unknown type'))

    // only logs request with answers at this moment
    if (!(obj["id.orig_h"] && obj.answers && obj.answers.length && obj.query && obj.query.length))
      return

    if (sysManager.isSearchDomain(obj.query) || sysManager.isLocalDomain(obj.query)) return

    await this.saveDNSFlow(obj)

    try {
      this.dnsCount ++
      // include device mac/ip here so conntrack could be updated
      const cacheKey = `${obj.query}:${obj.qtype}`
      // use peek, we don't want the popular searches always cached and never update redis
      const cached = this.dnsCache.peek(cacheKey)
      if (cached) this.dnsHit ++
      const cacheHit = cached && obj.answers.every(as => cached.has(as))
      if (cacheHit) {
        // if (this.dnsMatch++ % 10 == 0) log.verbose(`Duplicated DNS ${this.dnsMatch} / ${this.dnsHit} / ${this.dnsCount} `)
        log.debug("processDnsData:DNS:Duplicated:", obj['query'], JSON.stringify(obj['answers']));
      } else {
        this.dnsCache.set(cacheKey, new Set(obj.answers))
      }
      if (obj["qtype_name"] === "PTR") {
        if (cacheHit) return

        // reverse DNS query, the IP address is in the query parameter, the domain is in the answers
        if (obj["query"].endsWith(".in-addr.arpa")) {
          // ipv4 reverse DNS query
          const address = obj["query"].substring(0, obj["query"].length - ".in-addr.arpa".length).split('.').reverse().join('.');
          if (!address || !net.isIPv4(address) || ipUtil.isPrivate(address))
            return;
          const domains = obj["answers"]
            .filter(answer => !net.isIP(answer) && isDomainValid(answer)).map(answer => formulateHostname(answer));
          if (domains.length == 0)
            return;
          for (const domain of domains) {
            if (sysManager.isLocalDomain(domain) || sysManager.isSearchDomain(domain))
              continue;
            await dnsTool.addReverseDns(domain, [address]);
            await dnsTool.addDns(address, domain, config.dns.expires);
          }
          sem.emitEvent({
            type: 'DestIPFound',
            ip: address,
            from: "dns",
            suppressEventLogging: true
          });
        }
      } else {
        if (!isDomainValid(obj["query"]))
          return;

        // always sets conntrack so we keep the latest domain ip mapping
        const answers = obj['answers'].filter(answer => !firewalla.isReservedBlockingIP(answer) && net.isIP(answer));
        const query = formulateHostname(obj['query']);
        for (const answer of answers) {
          // l2 addr is added to dns.log in dns-mac-logging.zeek
          await conntrack.setConnEntries(
            obj["orig_l2_addr"] ? obj["orig_l2_addr"].toUpperCase() : obj["id.orig_h"], "", answer, "", "dns",
            {proto: "dns", ip: answer, host: query.toLowerCase()}, 600
          );
        }

        if (cacheHit) return

        const cnames = obj['answers']
          .filter(answer => !net.isIP(answer) && isDomainValid(answer)).map(answer => formulateHostname(answer));

        if (sysManager.isSearchDomain(query) || sysManager.isLocalDomain(query))
          return;
        // record reverse dns as well for future reverse lookup
        await dnsTool.addReverseDns(query, answers);
        for (const cname of cnames)
          await dnsTool.addReverseDns(cname, answers);

        for (const answer of answers) {
          await dnsTool.addDns(answer, query, config.dns.expires);
          for (const cname of cnames) {
            await dnsTool.addDns(answer, cname, config.dns.expires);
          }
          /* No need to emit DestIPFound from dns log as it is more precise in processConnData,
           * this can reduce unnecessary overhead in DestIPFoundHook */
        }
      }
    } catch (e) {
      log.error("Detect:Dns:Error", e, data, e.stack);
    }
  }

  // We now seen a new flow coming ... which might have a new ip getting discovered, lets take care of this
  indicateNewFlowSpec(flowspec) {
    let ip = flowspec.lh;
    if (!this.pingedIp) {
      this.pingedIp = new LRU({max: 10000, maxAge: 1000 * 60 * 60 * 24, updateAgeOnGet: false})
    }
    if (!this.pingedIp.has(ip)) {
      // probably issue ping here for ARP cache and later used in IPv6DiscoverySensor
      if (net.isIPv6(ip)) {
        // ip -6 neighbor may expire the ping pretty quickly, need to ping a few times to have sensors
        // pick up the new data
        log.debug("Conn:Learned:Ip", "ping ", ip, flowspec.uid);
        linux.ping6(ip)
        setTimeout(() => {
          linux.ping6(ip)
        }, 1000 * 60 * 4);
        setTimeout(() => {
          linux.ping6(ip)
        }, 1000 * 60 * 8);
        this.pingedIp.set(ip, true)
      }
    }
  }

  /*
   * {"ts":1464303791.790091,"uid":"CosE7p2gSFbxvdRig2","id.orig_h":"fe80::6a5b:35ff:fec9:b9cb","id.orig_p":143,"id.resp_h":"ff02::16","id.resp_p":0,"proto":"icmp","conn_state":"OTH","local_orig":false,"local_resp":false,"missed_bytes":0,"orig_pkts":1,"orig_ip_bytes":196,"resp_pkts":0,"resp_ip_bytes":0,"tunnel_parents":[]}

    2016-05-27T06:00:34.110Z - debug: Conn:Save 0=flow:conn:in:192.168.2.232, 1=1464328691.497809, 2={"ts":1464328691.497809,"uid":"C3Lb6y27y6fEbngara","id.orig_h":"192.168.2.232","id.orig_p":58137,"id.resp_h":"216.58.194.194","id.resp_p":443,"proto":"tcp","service":"ssl","duration":136.54717,"orig_bytes":1071,"resp_bytes":5315,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":48,"orig_ip_bytes":4710,"resp_pkts":34,"resp_ip_bytes":12414,"tunnel_parents":[]}
  */

  // assuming identity is pre-checked and result is passed
  isMonitoring(intf, monitorable) {
    if (!hostManager.isMonitoring())
      return false;

    if (monitorable && !monitorable.isMonitoring())
      return false

    if (intf) {
      const uuid = intf && intf.uuid;
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (networkProfile && !networkProfile.isMonitoring()) {
        return false;
      }
    }

    return true;
  }

  isDNSCacheOn(intf, monitorable) {
    let policy = _.get(monitorable, 'policy.dnsmasq.dnsCaching', undefined)
    if (policy !== undefined)
      return policy

    if (intf) {
      const uuid = intf && intf.uuid;
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      policy = _.get(networkProfile, 'policy.dnsmasq.dnsCaching', undefined)
      if (policy !== undefined)
        return policy
    }

    return (monitorable && monitorable.constructor || Monitorable).defaultPolicy().dnsmasq.dnsCaching;
  }

  isConnFlowValid(intf, monitorable) {
    let m = mode.getSetupModeSync()
    if (!m) {
      return true               // by default, always consider as valid
    }

    // ignore any devices' traffic who is set to monitoring off
    return this.isMonitoring(intf, monitorable)
  }

  async validateConnData(obj) {
    const threshold = config.threshold;
    const iptcpRatio = threshold.IPTCPRatio || 0.1;

    const missed_bytes = obj.missed_bytes;
    const resp_bytes = obj.resp_bytes;
    const orig_bytes = obj.orig_bytes;
    const orig_ip_bytes = obj.orig_ip_bytes;
    const resp_ip_bytes = obj.resp_ip_bytes;
    const orig_pkts = obj.orig_pkts;
    const resp_pkts = obj.resp_pkts;
    const resp_port = obj["id.resp_p"];
    // missed bytes that are randomly skipped on ssl traffic may lead to inaccurate ip tcp ratio
    if (resp_port == 443)
      return true;

    if (missed_bytes / (resp_bytes + orig_bytes) > threshold.missedBytesRatio) {
        log.debug("Conn:Drop:MissedBytes:RatioTooLarge", obj.conn_state, obj);
        return false;
    }

    if (orig_ip_bytes && orig_bytes &&
      (orig_ip_bytes > 1000 || orig_bytes > 1000) &&
      orig_pkts > 0 && (orig_ip_bytes / orig_pkts < 1400) && // if multiple packets are assembled into one packet, orig(resp)_ip_bytes may be much less than orig(resp)_bytes
      (orig_ip_bytes / orig_bytes) < iptcpRatio) {
      log.debug("Conn:Drop:IPTCPRatioTooLow:Orig", obj.conn_state, obj);
      return false;
    }

    if (resp_ip_bytes && resp_bytes &&
      (resp_ip_bytes > 1000 || resp_bytes > 1000) &&
      resp_pkts > 0 && (resp_ip_bytes / resp_pkts < 1400) &&
      (resp_ip_bytes / resp_bytes) < iptcpRatio) {
      log.debug("Conn:Drop:IPTCPRatioTooLow:Resp", obj.conn_state, obj);
      return false;
    }

    if(threshold.maxSpeed) {
      const maxBytesPerSecond = threshold.maxSpeed / 8;
      const duration = obj.duration;
      const maxBytes = maxBytesPerSecond * duration;

      // more than the therotical possible number
      if(obj.missed_bytes > maxBytes) {
        log.debug("Conn:Drop:MissedBytes:TooLarge", obj.conn_state, obj);
        return false;
      }

      // if duration too small then it's probably just 1 packet
      if(obj.resp_bytes > maxBytes && duration > 0.0001 || obj.resp_bytes > 2000 && duration <= 0.0001) {
        log.debug("Conn:Drop:RespBytes:TooLarge", obj.conn_state, obj);
        return false;
      }

      if(obj.orig_bytes > maxBytes && duration > 0.0001 || obj.orig_bytes > 2000 && duration <= 0.0001) {
        log.debug("Conn:Drop:OrigBytes:TooLarge", obj.conn_state, obj);
        return false;
      }
    }

    // this is a very old check, assume it was added for something in spoof mode
    // FTP data channel would fail this check and never get logged
    if (obj.proto == "tcp" && await mode.isSpoofModeOn()) {
      if (obj.resp_bytes > threshold.tcpZeroBytesResp && obj.orig_bytes == 0 && obj.conn_state == "SF") {
        log.error("Conn:Adjusted:TCPZero", obj.conn_state, obj);
        return false
      }
      else if (obj.orig_bytes > threshold.tcpZeroBytesOrig && obj.resp_bytes == 0 && obj.conn_state == "SF") {
        log.error("Conn:Adjusted:TCPZero", obj.conn_state, obj);
        return false
      }
    }

    if (obj.orig_bytes > threshold.logLargeBytesOrig) {
      log.warn("Conn:Debug:Orig_bytes:", obj.orig_bytes, obj.uid, obj['id.orig_h'], obj['id.resp_h']);
    }
    if (obj.resp_bytes > threshold.logLargeBytesResp) {
      log.warn("Conn:Debug:Resp_bytes:", obj.resp_bytes, obj.uid, obj['id.orig_h'], obj['id.resp_h']);
    }

    return true;
  }

  async processLongConnData(data) {
    return this.processConnData(data, true);
  }

  reverseConnFlow(obj) {
    const tuples = [
      ["id.orig_h", "id.resp_h"],
      ["id.orig_p", "id.resp_p"],
      ["orig_bytes", "resp_bytes"],
      ["local_orig", "local_resp"],
      ["orig_pkts", "resp_pkts"],
      ["orig_ip_bytes", "resp_ip_bytes"],
      ["orig_l2_addr", "resp_l2_addr"]
    ];
    for (const tuple of tuples) {
      const tmp = obj[tuple[0]];
      obj[tuple[0]] = obj[tuple[1]];
      obj[tuple[1]] = tmp;
    }
  }

  async waitAndGetIdentity(ip) {
    let identity = IdentityManager.getIdentityByIP(ip);
    let retry = 2
    while (!identity && !IdentityManager.isInitialized() && retry--) {
      await delay(10 * 1000)
      identity = IdentityManager.getIdentityByIP(ip);
    }
    return identity
  }

  async processConnData(data, long = false, reverseLocal = false) {
    try {
      let obj = JSON.parse(data);
      if (obj == null) {
        log.debug("Conn:Drop", obj);
        return;
      }

      // from zeek script heartbeat-flow
      if (obj.uid == '0' && obj['id.orig_h'] == '0.0.0.0' && obj["id.resp_h"] == '0.0.0.0') {
        await rclient.multi()
          .zadd('flow:conn:00:00:00:00:00:00', Date.now() / 1000, data)
          .expire('flow:conn:00:00:00:00:00:00', config.conn.expires)
          .execAsync()
        // return here so it doesn't go to flow stash
        return
      }

      if (obj.proto == "icmp") {
        return;
      }

      if (obj.service && obj.service == "dns" || obj["id.resp_p"] == 53 || obj["id.orig_p"] == 53) {
        return;
      }

      if (obj['id.orig_h'] == '127.0.0.1' || obj["id.resp_h"] == '127.0.0.1' || obj['id.orig_h'] == '::1' || obj["id.resp_h"] == '::1')
        return

      // drop layer 3
      if (obj.orig_ip_bytes == 0 && obj.resp_ip_bytes == 0) {
        // log.debug("Conn:Drop:ZeroLength", obj.conn_state, obj);
        return;
      }

      if (obj.proto == 'udp') {
        // IP header (20) + UDP header (8)
        if (obj.orig_ip_bytes && obj.orig_bytes == undefined) obj.orig_bytes = obj.orig_ip_bytes - 28
        if (obj.resp_ip_bytes && obj.resp_bytes == undefined) obj.resp_bytes = obj.resp_ip_bytes - 28
      }

      if (obj.orig_bytes == undefined || obj.resp_bytes == undefined) {
        // log.debug("Conn:Drop:NullBytes", obj);
        return;
      }

      // drop layer 4
      if (obj.orig_bytes == 0 && obj.resp_bytes == 0) {
        // log.debug("Conn:Drop:ZeroLength2", obj.conn_state, obj);
        return;
      }

      // when reversed, number on long conn is substraced and might fail here
      if (!reverseLocal && !await this.validateConnData(obj)) {
        return;
      }

      /*
       * the s flag is a short packet flag,
       * meaning the flow was not detect complete.  This can happen due to pcap runs before
       * the firewall, and due to how spoof working, there are periods that packets may
       * leak, which causes the strange detection.  This need to be look at later.
       *
       * this problem does not exist in DHCP mode.
       *
       * when flag is set to 's', intel should ignore
       */
      if (obj.proto == "tcp") {
        // beware that OTH may occur in long lasting connections intermittently
        // states count as normal: S1, S2, S3, SF, RSTO, RSTR, OTH
        if ((obj.conn_state == "REJ" ||
          obj.conn_state == "RSTOS0" || obj.conn_state == "RSTRH" ||
          obj.conn_state == "SH" || obj.conn_state == "SHR" ||
          obj.conn_state == "S0") && (obj.orig_bytes == 0 || obj.resp_bytes == 0)) {
          log.debug("Conn:Drop:State:P1", obj.conn_state, data);
          // return directly for the traffic flagged as 's'
          return;
        }

        if (["RSTR", "RSTO", "S1", "S3", "SF"].includes(obj.conn_state) && obj.orig_pkts <= 10 && obj.resp_bytes == 0) {
          log.debug("Conn:Drop:TLS", obj.conn_state, data);
          // Likely blocked by TLS. In normal cases, the first packet is SYN, the second packet is ACK, the third packet is SSL client hello. conn_state will be "RSTR"
          // However, if zeek is listening on bridge interface, it will not capture tcp-reset from iptables due to br_netfilter kernel module.
          // In this case, the remote server will send a FIN after 60 seconds and may be rejected by local device. The orig_pkts will be 4. conn_state may be "RSTO", "S3", or "SF".
          // In rare cases, the originator will re-transmit data packets if the tcp-reset from iptables is not received. The orig_pkts will be more than 3 (or 4 if zeek listens on bridge). conn_state will be "RSTO" or "RSTR"
          // Another possible corner case is, after RST is sent to the originator without being seen by zeek, zeek will still record the conn_state as "S1" if there is no subsequent packets from both sides
          return;
        }
      }

      const orig = obj["id.orig_h"];
      const resp = obj["id.resp_h"];
      let flowdir = "in";
      let lhost = null;
      let dhost = null;
      const origMac = obj.orig_l2_addr && (obj.orig_l2_addr.length == 17 ? obj.orig_l2_addr.toUpperCase() : obj.orig_l2_addr);
      const respMac = obj.resp_l2_addr && (obj.resp_l2_addr.length == 17 ? obj.resp_l2_addr.toUpperCase() : obj.resp_l2_addr);
      let localMac = null;
      let dstMac = null;
      let intfId = null;
      const localOrig = obj["local_orig"];
      const localResp = obj["local_resp"];
      let localFlow = false
      let bridge = obj["bridge"] || false;

      log.debug("ProcessingConnection:", obj.uid, orig, resp, obj['id.resp_p'],
        long ? 'long' : '', reverseLocal ? 'reverseLocal' : '');

      // fd: in, this flow initiated from inside
      // fd: out, this flow initated from outside, it is more dangerous

      // zeek uses networks.cfg (check BroControl.js) determining local_orig and local_resp
      // so this is IP based and pretty realiable, except for multicast addresses
      if (localOrig == true && localResp == true) {
        if (!fc.isFeatureOn(Constants.FEATURE_LOCAL_FLOW) ||
          !(await mode.isRouterModeOn() || await sysManager.isBridgeMode())
        ) return;

        if (reverseLocal) {
          flowdir = 'out'
          lhost = resp
          dhost = orig
          localMac = respMac
          dstMac = origMac
        } else {
          flowdir = 'in';
          lhost = orig;
          dhost = resp;
          localMac = origMac;
          dstMac = respMac;
        }
        localFlow = true
      } else if (localOrig == true && localResp == false) {
        flowdir = "in";
        lhost = orig;
        dhost = resp;
        localMac = origMac;
      } else if (localOrig == false && localResp == true) {
        flowdir = "out";
        lhost = resp;
        dhost = orig;
        localMac = respMac;
      } else {
        log.debug("Conn:Error:Drop", data, orig, resp, localOrig, localResp);
        return;
      }

      if (localMac == "FF:FF:FF:FF:FF:FF" || localFlow && respMac == 'FF:FF:FF:FF:FF:FF')
        return;

      const fam = net.isIP(lhost)
      if (!fam) {
        log.error('Conn:Error:Drop Invalid local IP', lhost)
        return
      }

      let intfInfo = sysManager.getInterfaceViaIP(lhost, fam);
      let dstIntfInfo = localFlow && sysManager.getInterfaceViaIP(dhost, fam);
      // do not process traffic between devices in the same network unless bridge flag is set in log
      if (intfInfo === dstIntfInfo && !bridge)
        return;
      // ignore multicast IP
      try {
        // zeek has problem recognizeing multicast addresses as local, so direction could be wrong
        if (fam == 4 && (
          sysManager.isMulticastIP4(lhost, intfInfo && intfInfo.name) ||
          sysManager.isMulticastIP4(dhost, dstIntfInfo && dstIntfInfo.name)
        ) || fam == 6 && (
          sysManager.isMulticastIP6(lhost) ||
          sysManager.isMulticastIP6(dhost)
        )) {
          return;
        }
        if (sysManager.isMyServer(resp) || sysManager.isMyServer(orig)) {
          return;
        }
      } catch (e) {
        log.debug("Conn:Data:Error checking multicast", e);
        return;
      }

      const isIdentityIntf = this.isIdentityLAN(intfInfo)

      // local flow will be recorded twice on two different interfaces by zeek, only count the ingress flow on one interface
      // TODO: this condition check does not cover the case if both ends are VPN devices, but this rarely happens
      if (localFlow && !reverseLocal && (origMac && sysManager.isMyMac(origMac) || isIdentityIntf && respMac))
        return;

      // ignore any traffic originated or to walla itself
      if (fam == 4 && (sysManager.isMyIP(orig) || sysManager.isMyIP(resp))
       || fam == 6 && (sysManager.isMyIP6(orig) || sysManager.isMyIP6(resp))) {
        return
      }

      let localType = TYPE_MAC;
      let realLocal = null;
      let monitorable = null;
      if (isIdentityIntf) {
        monitorable = await this.waitAndGetIdentity(lhost);
        if (monitorable) {
          localMac = IdentityManager.getGUID(monitorable);
          if (fam == 4)
            realLocal = IdentityManager.getEndpointByIP(lhost);
          localType = TYPE_VPN;
        }
      } else {
        // local flow only available in router mode, so gateway is always Firewalla's mac
        // for non-local flows, this only happens in simple mode
        if (localMac && !reverseLocal && (sysManager.isMyMac(localMac) ||
          localFlow && await sysManager.isBridgeMode() && intfInfo && intfInfo.gatewayMac == localMac
        )) {
          log.debug("Discard incorrect local MAC address from bro log: ", localMac, lhost);
          localMac = null; // discard local mac from bro log since it is not correct
        }

        if (!localMac)
          localMac = await hostTool.getMacByIPWithCache(lhost)
        if (localMac)
          monitorable = hostManager.getHostFastByMAC(localMac);
        else {
          log.verbose('NO LOCAL MAC! Drop flow', data)
          return
        }

        // recored device heartbeat
        // as flows with invalid conn_state are removed, all flows here could be considered as valid
        // this should be done before device monitoring check, we still want heartbeat update from unmonitored devices
        this.recordDeviceHeartbeat(localMac, Math.round((obj.ts + obj.duration) * 100) / 100, lhost, fam)
      }

      // for v6 link-local addresses
      if (!intfInfo && monitorable) {
        intfInfo = sysManager.getInterfaceViaUUID(monitorable && monitorable.o.intf);
      }

      if (!this.isConnFlowValid(intfInfo, monitorable))
        return;

      if (obj.proto === "udp" && accounting.isBlockedDevice(localMac)) {
        return; // ignore udp traffic if they are not valid
      }

      /*
      if ((obj.orig_bytes > obj.orig_ip_bytes || obj.resp_bytes > obj.resp_ip_bytes) && obj.proto == "tcp") {
        log.debug("Conn:Burst:Adjust1", obj);
        obj.orig_bytes = obj.orig_ip_bytes;
        obj.resp_bytes = obj.resp_ip_bytes;
      }
      */

      if (obj.orig_bytes == null) {
        obj.orig_bytes = 0;
      }
      if (obj.resp_bytes == null) {
        obj.resp_bytes = 0;
      }

      if (obj.duration == null) {
        obj.duration = 0;
      }

      // keep only 2 digits after decimal to save memory
      obj.ts = Math.round(obj.ts * 100) / 100
      obj.duration = Math.round(obj.duration * 100) / 100

      let connEntry, outIntfId
      if (!localFlow && obj['id.orig_h'] && obj['id.resp_h'] && obj['id.orig_p'] && obj['id.resp_p'] && obj['proto']) {
        connEntry = await conntrack.getConnEntries(obj['id.orig_h'], obj['id.orig_p'], obj['id.resp_h'], obj['id.resp_p'], obj['proto'], 600);
        if (connEntry) {
          const { oIntf, redirect } = connEntry
          if (oIntf) outIntfId = oIntf.startsWith(Constants.ACL_VPN_CLIENT_WAN_PREFIX) ? oIntf : oIntf.substring(0, 8)
          if (redirect) return
        } else if (obj.conn_state === "OTH" || obj.conn_state === "SF" || (obj.proto === "tcp" && !_.get(obj, "history", "").startsWith("S"))) {
          connEntry = await conntrack.getConnEntries(obj['id.resp_h'], obj['id.resp_p'], obj['id.orig_h'], obj['id.orig_p'], obj['proto'], 600);
          // if reverse flow is found in conntrack, likely flow direction from zeek is wrong after zeek is restarted halfway
          if (connEntry) {
            if (connEntry.redirect) return
            // if 'history' starts with '^', it means connection direction is flipped by zeek's heuristic
            // it is instructed by likely_server_ports in zeek config and we trust it
            if (!(obj.history && obj.history.startsWith('^'))) {
              this.reverseConnFlow(obj);
              await this.processConnData(JSON.stringify(obj), long);
              return;
            }
          }
        }
      }
      if (flowdir == "in" && !localFlow)
        conntrack.setConnRemote(obj['proto'], obj['id.resp_h'], obj['id.resp_p']);

      // Long connection aggregation
      const uid = obj.uid
      if (long || this.activeLongConns.has(uid) && !reverseLocal) {
        // zeek has a bug that stales connection and keeps popping them in conn_long.log
        if (obj.ts + obj.duration < Date.now() / 1000 - config.connLong.expires) return

        const previous = this.activeLongConns.get(uid) || { ts: obj.ts, orig_bytes:0, resp_bytes: 0, duration: 0, lastTick: obj.ts}

        // already aggregated
        if (previous.duration > obj.duration) return;

        // this.activeLongConns[uid] will be cleaned after certain time of inactivity
        if (!long && obj.proto === "tcp" && (obj.conn_state === "SF" || obj.conn_state === "RSTO" || obj.conn_state === "RSTR")) // explict termination of a TCP connection in conn.log (not conn_long.log)
          this.activeLongConns.delete(uid);
        else
          this.activeLongConns.set(uid, Object.assign(_.pick(obj, ['ts', 'orig_bytes', 'resp_bytes', 'duration']), {lastTick: Date.now() / 1000}))

        // make fields in obj reflect the bytes and time in the last fragment of a long connection
        obj.duration = Math.round(Math.max(0.01, obj.ts + obj.duration - previous.lastTick) * 100) / 100 // duration is at least 0.01
        obj.ts = Math.round(Math.max(previous.ts + previous.duration, previous.lastTick) * 100) / 100
        obj.orig_bytes -= previous.orig_bytes
        obj.resp_bytes -= previous.resp_bytes

        if (obj.orig_bytes <= 0 && obj.resp_bytes <= 0) {
          log.silly("Conn:Drop:ZeroLength_Long", obj.conn_state, obj);
          return;
        }
      }

      if (intfInfo && intfInfo.uuid) {
        intfId = intfInfo.uuid.substring(0, 8); // use only first potion to save memory
      } else {
        // no monitorable happens as it might not have been created as flow is seen
        // no interface doesn't really makes sense here
        log.error('Conn: Unable to find nif uuid', lhost, localMac);
        return
      }

      // save flow under the destination host key for per device indexing
      // do this after we get real bytes in long connection
      let dstMonitorable = null;
      let dstRealLocal = null
      if (localFlow) {
        const isDstIdentityIntf = this.isIdentityLAN(dstIntfInfo)
        if (isDstIdentityIntf) {
          dstMonitorable = await this.waitAndGetIdentity(dhost);
          if (dstMonitorable) {
            dstMac = IdentityManager.getGUID(dstMonitorable);
            dstRealLocal = IdentityManager.getEndpointByIP(dhost);
          }
        } else {
          if (dstMac && !reverseLocal && sysManager.isMyMac(dstMac)) {
            // double check dest mac for spoof leak
            log.debug("Discard incorrect dest MAC address from bro log: ", dstMac, dhost);
            dstMac = null
          }
          // zeeks records inter-network local flow twice in bridge mode, on both interfaces, drop one here to deduplicate
          // if source is a VPN client, IP is NATed on the other interface and zeek sees it from Firewalla itself thus dropped
          // don't drop in this case. also connection going to VPN client is not possible in bridge mode
          if (!reverseLocal && !isIdentityIntf && await sysManager.isBridgeMode() &&
            dstIntfInfo && dstIntfInfo.gatewayMac == dstMac
          ) {
            log.debug("Drop duplicated bridge traffic when dstMac is gateway: ", lhost, dhost);
            return
          }

          if (!dstMac)
            dstMac = await hostTool.getMacByIPWithCache(dhost)
          if (dstMac)
            dstMonitorable = hostManager.getHostFastByMAC(dstMac);
          else {
            log.verbose('NO DST MAC! Drop flow', data);
            return;
          }
        }

        if (!dstIntfInfo || !dstIntfInfo.uuid) {
          // this usually happens on ipv6 link local address
          if (dhost && dhost.startsWith("fe80")) {
            const uuid = dstMonitorable && dstMonitorable.getNicUUID();
            if (uuid) {
              dstIntfInfo = sysManager.getInterfaceViaUUID(uuid);
            }
          }
          if (!dstIntfInfo || !dstIntfInfo.uuid) {
            log.error('Conn: Unable to find dst intf', dhost, dstMac);
            return;
          }
        }
        if (obj.proto === "udp" && accounting.isBlockedDevice(dstMac)) {
          return
        }

        if (!reverseLocal) {
          // dst == resp && dstMac == respMac
          // writes obj so reverse processing doesn't have to do this
          obj["orig_l2_addr"] = localMac
          obj["resp_l2_addr"] = dstMac

          this.processConnData(JSON.stringify(obj), false, true)
        }
      }

      // flowstash is the aggregation of flows within FLOWSTASH_EXPIRES seconds
      const now = Date.now() / 1000; // keep it as float, reduce the same score flows
      const flowspecKey = `${localMac}:${orig}:${resp}:${outIntfId || ""}:${obj['id.resp_p'] || ""}`;

      const tmpspec = {
        ts: obj.ts, // ts stands for start timestamp
        _ts: getUniqueTs(now), // _ts is the last time updated, make it unique to avoid missing flows in time-based query
        sh: orig, // source
        dh: resp, // dstination
        ob: Number(obj.orig_bytes), // transfer bytes
        rb: Number(obj.resp_bytes),
        ct: 1, // count
        fd: flowdir, // flow direction
        lh: lhost, // this is local ip address
        intf: intfId, // intf id
        du: obj.duration,
        pr: obj.proto,
        uids: [],
        ltype: localType
      };

      // uids is only used to correlate with uri in http.log
      if (obj.service === "http")
        tmpspec.uids.push(obj.uid);

      if (localFlow) {
        tmpspec.dmac = dstMac
        tmpspec.dIntf = dstIntfInfo.uuid.substring(0, 8)
        if (dstRealLocal)
          tmpspec.drl = this.extractIP(dstRealLocal)
      } else {
        tmpspec.oIntf = outIntfId // egress intf id
        tmpspec.af = {} //application flows
      }

      if (connEntry && connEntry.apid && Number(connEntry.apid)) {
        tmpspec.apid = Number(connEntry.apid); // allow rule id
      }

      if (connEntry && connEntry.rpid && Number(connEntry.rpid)) {
        tmpspec.rpid = Number(connEntry.rpid); // route rule id
      }

      const tags = await hostTool.getTags(monitorable, intfInfo && intfInfo.uuid)
      const dstTags = await hostTool.getTags(dstMonitorable, dstIntfInfo && dstIntfInfo.uuid)
      Object.assign(tmpspec, tags)
      tmpspec.dstTags = dstTags

      if (monitorable instanceof Identity)
        tmpspec.guid = IdentityManager.getGUID(monitorable);
      if (realLocal)
        tmpspec.rl = this.extractIP(realLocal);

      // id.orig_p can be an array in local flow
      if (obj['id.orig_p']) tmpspec.sp = _.isArray(obj['id.orig_p']) ? obj['id.orig_p'] : [obj['id.orig_p']];
      if (obj['id.resp_p']) tmpspec.dp = obj['id.resp_p'];

      // might be blocked UDP packets, checking conntrack
      // blocked connections don't leave a trace in conntrack
      if (tmpspec.pr == 'udp' && (tmpspec.ob == 0 || tmpspec.rb == 0) && !localFlow) {
        if (!outIntfId) {
          log.debug('Dropping blocked UDP', tmpspec)
          return
        }
      }

      const sigs = this.getConnSignatures(uid);
      if (!_.isEmpty(sigs))
        tmpspec.sigs = sigs;

      let afobj, afhost
      if (!localFlow) {
        afobj = this.withdrawAppMap(orig, obj['id.orig_p'], resp, obj['id.resp_p'], long || this.activeLongConns.has(obj.uid)) || connEntry;
        if (!afobj || !afobj.host) {
          afobj = await conntrack.getConnEntries(origMac ? origMac : orig, "", resp, "", "dns", 600); // use recent DNS lookup records from this IP as a fallback to parse application level info
          if (afobj && afobj.host)
            await conntrack.setConnEntries(orig, obj["id.orig_p"], resp, obj["id.resp_p"], obj.proto, afobj, 600); // sync application level info from recent DNS lookup to five-tuple key of this connection
        }

        if (afobj && afobj.host && flowdir === "in") { // only use information in app map for outbound flow, af describes remote site
          tmpspec.af[afobj.host] = _.pick(afobj, ["proto", "ip"]);
          afhost = afobj.host
        }
      }

      this.indicateNewFlowSpec(tmpspec);

      const traffic = [tmpspec.ob, tmpspec.rb]
      if (tmpspec.fd == 'in') traffic.reverse()

      const tuple = { download: traffic[0], upload: traffic[1] }
      if (localFlow) {
        const tupleConn = {conn: tmpspec.ct}
        const tupleIntra = { intra: tmpspec.ob + tmpspec.rb }

        this.recordTraffic(tupleIntra, 'lo:global')
        this.recordTraffic(tupleConn, 'lo:intra:global')

        this.recordTraffic(tuple, 'lo:' + localMac)
        this.recordTraffic(tupleConn, `lo:${flowdir}:${localMac}`)

        if (dstIntfInfo && intfInfo.uuid == dstIntfInfo.uuid) {
          this.recordTraffic(tupleIntra, 'lo:intf:' + intfInfo.uuid)
          this.recordTraffic(tupleConn, 'lo:intra:intf:' + intfInfo.uuid)
        } else {
          this.recordTraffic(tuple, 'lo:intf:' + intfInfo.uuid)
          this.recordTraffic(tupleConn, `lo:${flowdir}:intf:${intfInfo.uuid}`)
        }

        for (const key in tags) {
          for (const tag of tags[key]) {
            if (dstTags[key] && dstTags[key].includes(tag)) {
              this.recordTraffic(tupleIntra, 'lo:tag:' + tag)
              this.recordTraffic(tupleConn, 'lo:intra:tag:' + tag)
            } else {
              this.recordTraffic(tuple, 'lo:tag:' + tag)
              this.recordTraffic(tupleConn, `lo:${flowdir}:tag:${tag}`)
            }
          }
        }
      } else {
        tuple.conn = tmpspec.ct
        this.recordTraffic(tuple, localMac);
        this.recordTraffic(tuple, 'global');
        this.recordTraffic(tuple, 'intf:' + intfInfo.uuid);
        for (const key in tags) {
          for (const tag of tags[key]) {
            this.recordTraffic(tuple, 'tag:' + tag);
          }
        }
      }

      // Single flow is written to redis first to prevent data loss
      // will be aggregated on flow stash expiration and removed in most cases
      const key = flowTool.getLogKey(localMac, {direction: tmpspec.fd, localFlow})
      let strdata = JSON.stringify(tmpspec);

      // beware that _ts is used as score in flow:conn:* zset, since _ts is always monotonically increasing
      let redisObj = [key, tmpspec._ts, strdata];
      // log.debug("Conn:Save:Temp", redisObj);

      // adding keys to flowstash (but not redis)
      tmpspec.mac = localMac
      if (localFlow) tmpspec.local = true

      if (tmpspec.fd == 'out' && !localFlow) {
        this.recordOutPort(localMac, tmpspec);
      }

      const multi = rclient.multi()
      multi.zadd(redisObj)
      // no need to set ttl here, OldDataCleanSensor will take care of it
      multi.zadd("deviceLastFlowTs", now, localMac);
      await multi.execAsync().catch(
        err => log.error("Failed to save tmpspec: ", tmpspec, err)
      )

      const remoteIPAddress = (tmpspec.lh === tmpspec.sh ? tmpspec.dh : tmpspec.sh);
      let remoteHost = null;
      if (afhost && _.isObject(afobj) && afobj.ip === remoteIPAddress) {
        remoteHost = afhost;
      }

      let flowspec = this.flowstash.conn[flowspecKey];
      if (flowspec == null) {
        flowspec = tmpspec
        this.flowstash.conn[flowspecKey] = flowspec;
      } else {
        flowspec.ob += tmpspec.ob;
        flowspec.rb += tmpspec.rb;
        flowspec.ct += 1;
        if (flowspec.ts > tmpspec.ts) {
          // update start timestamp
          flowspec.ts = tmpspec.ts;
        }
        const ets = Math.max(flowspec.ts + flowspec.du, tmpspec.ts + tmpspec.du)
        // update last time updated
        flowspec._ts = Math.max(flowspec._ts, tmpspec._ts);
        // TBD: How to define and calculate the duration of flow?
        //      The total time of network transfer?
        //      Or the length of period from the beginning of the first to the end of last flow?
        // Fow now, we use the length of period from to keep it consistent with app time usage calculation
        flowspec.du = Math.round((ets - flowspec.ts) * 100) / 100;
        flowspec.uids.includes(obj.uid) || flowspec.uids.push(obj.uid)

        if (obj['id.orig_p']) {
          if (_.isArray(obj['id.orig_p']))
            flowspec.sp.push(...(obj['id.orig_p'].filter(p => !flowspec.sp.includes(p))));
          else {
            if (!flowspec.sp.includes(obj['id.orig_p']))
              flowspec.sp.push(obj['id.orig_p']);
          }
        }
        if (!_.isEmpty(sigs))
          flowspec.sigs = _.union(flowspec.sigs, sigs);
        if (afhost && !flowspec.af[afhost]) {
          flowspec.af[afhost] = _.pick(afobj, ["proto", "ip"]);
        }
      }

      if (localFlow) {
        // no need to go through DestIPFoundHook
        sem.emitLocalEvent({
          type: Message.MSG_FLOW_ENRICHED,
          suppressEventLogging: true,
          flow: Object.assign({}, tmpspec, {intf: intfInfo.uuid, dIntf: dstIntfInfo.uuid}),
        });
      }

      setTimeout(() => {
        // no need to go through DestIPFoundHook for localFlow
        if (!localFlow) {
          sem.emitEvent({
            type: 'DestIPFound',
            ip: remoteIPAddress,
            host: remoteHost,
            fd: tmpspec.fd,
            flow: Object.assign({}, tmpspec, { ip: remoteIPAddress, host: remoteHost, intf: intfInfo.uuid }),
            from: "flow",
            suppressEventLogging: true,
            mac: localMac
          });
          if (realLocal) {
            sem.emitEvent({
              type: 'DestIPFound',
              from: "VPN_endpoint",
              ip: tmpspec.rl,
              suppressEventLogging: true
            });
          }
        }
        sem.emitLocalEvent({
          type: "Flow2Stream",
          suppressEventLogging: true,
          raw: tmpspec,
          audit: false
        })
      }, 1 * 1000); // make it a little slower so that dns record will be handled first

    } catch (e) {
      log.error("Conn:Error Unable to save", e, data);
    }
  }

  async rotateFlowStash(type) {
    const flowstash = this.flowstash[type]
    this.flowstash[type] = {}
    let end = Date.now() / 1000
    const start = this.lastRotate[type]

    // Every FLOWSTASH_EXPIRES seconds, save aggregated flowstash into redis and empties flowstash
    let stashed = {};
    log.info("Processing Flow Stash:", start, end, type);

    for (const specKey in flowstash) try {
      const spec = flowstash[specKey];
      if (!spec.mac)
        continue;
      if (type == 'conn' && !spec.local) try {
        // try resolve host info for previous flows again here
        for (const uid of spec.uids) {
          const afobj = this.withdrawAppMap(spec.sh, spec.sp[0] || 0, spec.dh, spec.dp, this.activeLongConns.has(uid)) || await conntrack.getConnEntries(spec.sh, spec.sp[0] || 0, spec.dh, spec.dp, spec.pr, 600);;
          if (spec.fd === "in" && afobj && afobj.host && !spec.af[afobj.host]) {
            spec.af[afobj.host] = _.pick(afobj, ["proto", "ip"]);
          }
        }
      } catch (e) {
        log.error("Conn:Save:AFMAP:EXCEPTION", e);
      }

      const key = type == 'conn'
        ? flowTool.getLogKey(spec.mac, {direction: spec.fd, localFlow: spec.local})
        : `flow:dns:${spec.mac}`
      // not storing mac (as it's in key) to squeeze memory
      delete spec.mac
      delete spec.local

      if (spec._ts > end) end = spec._ts
      const strdata = JSON.stringify(spec);
      // _ts is the last time this flowspec is updated
      const redisObj = [key, spec._ts, strdata];
      if (stashed[key]) {
        stashed[key].push(redisObj);
      } else {
        stashed[key] = [redisObj];
      }

    } catch (e) {
      log.error("Error rotating flowstash", specKey, start, end, flowstash[specKey], e);
    }
    this.lastRotate[type] = end

    setTimeout(async () => {
      log.info(`${type}:Save:Summary ${start} ${end}`);
      for (let key in stashed) {
        const stash = stashed[key];
        log.verbose(`${type}:Save:Wipe ${key} Resolved To: ${stash.length}`);

        let transaction = [];
        transaction.push(['zremrangebyscore', key, '('+start, end]);
        stash.forEach(robj => {
          if (robj._ts < start || robj._ts > end) log.warn('Stashed flow out of range', start, end, robj)
          transaction.push(['zadd', robj])
        })
        // no need to set ttl here, OldDataCleanSensor will take care of it

        try {
          await rclient.pipelineAndLog(transaction)
          log.verbose(`${type}:Save:Done`, key, start, end);
        } catch (err) {
          log.error(`${type}:Save:Error`, err);
        }
      }
    }, config[type].flowstashExpires * 1000);
  }

  cleanUpSanDNS(obj) {
    // san.dns may be an array, need to convert it to string to avoid redis warning
    if (obj["san.dns"] && obj["san.dns"].constructor === Array) {
      obj["san.dns"] = JSON.stringify(obj["san.dns"]);
    }

    if (obj["san.ip"] && obj["san.ip"].constructor === Array) {
      obj["san.ip"] = JSON.stringify(obj["san.ip"]);
    }

    if (obj["san.email"] && obj["san.email"].constructor === Array) {
      obj["san.email"] = JSON.stringify(obj["san.email"]);
    }
  }

  /*
  {"ts":1506313273.469781,"uid":"CX5UTb3cZi0zJdeQqe","id.orig_h":"192.168.2.191","id.orig_p":57334,"id.resp_h":"45.57.26.133","id.resp_p":443,"version":"TLSv12","cipher":"TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256","server_name":"ipv4_1-lagg0-c004.1.sjc005.ix.nflxvideo.net","resumed":true,"established":true}
  */
  async processSslData(data) {
    try {
      let obj = JSON.parse(data);
      if (obj == null) {
        log.error("SSL:Drop", obj);
        return;
      }

      if (this.proxyConn.get(obj.uid)) {
        log.verbose('Drop SSL because HTTP CONNECT recorded', obj.uid, obj.server_name)
        this.proxyConn.del(obj.uid)
        return
      }

      // do not process ssl log that does not pass the certificate validation
      if (obj["validation_status"] && obj["validation_status"] !== "ok")
        return;
      let dst = obj["id.resp_h"];
      if (firewalla.isReservedBlockingIP(dst))
        return;
      if (obj['server_name']) {
        obj['server_name'] = obj['server_name'].toLocaleLowerCase();
      }
      let dsthost = obj['server_name'];
      let subject = obj['subject'];
      let key = intelTool.getSSLCertKey(dst)
      let cert_chain_fuids = obj['cert_chain_fuids']; // present in zeek 3.x
      let cert_chain_fps = obj['cert_chain_fps']; // present in zeek 4.x
      let cert_id = null;
      let flowdir = "in";
      if (cert_chain_fuids != null && cert_chain_fuids.length > 0) {
        cert_id = cert_chain_fuids[0];
        log.debug("SSL:CERT_ID ", cert_id, subject, dst);
      } else {
        if (cert_chain_fps != null && cert_chain_fps.length > 0) {
          cert_id = cert_chain_fps[0];
        }
      }

      if ((subject != null || dsthost != null) && dst != null) {
        let xobj = {};
        if (subject != null) {
          xobj['subject'] = subject;
        }
        if (dsthost != null) {
          xobj['server_name'] = dsthost;
        }
        log.debug("SSL: host:ext:x509:Save", key, xobj);

        this.cleanUpSanDNS(xobj);

        try {
          const multi = rclient.multi()
          multi.unlink(key) // delete before hmset in case number of keys is not same in old and new data
          multi.hmset(key, xobj)
          if (config.ssl.expires) {
            multi.expireat(key, parseInt(Date.now() / 1000) + config.ssl.expires);
          }
          await multi.execAsync()
        } catch(err) {
          log.error("host:ext:x509:save:Error", key, subject);
        }
      } else if (cert_id != null) try {
        log.debug("SSL:CERT_ID flow.ssl creating cert", cert_id);
        const cert = await rclient.hgetallAsync("flow:x509:" + cert_id)
        log.debug("SSL:CERT_ID found ", cert);
        if (cert != null && cert["certificate.subject"]) {
          const xobj = {
            'subject': cert['certificate.subject']
          };
          if (cert.server_name) {
            xobj.server_name = cert.server_name;
          } else if (cert["certificate.subject"]) {
            const regexp = /CN=.*,/;
            const matches = cert["certificate.subject"].match(regexp);
            if (!_.isEmpty(matches)) {
              const match = matches[0];
              let server_name = match.split(/=|,/)[1];
              if (server_name.startsWith("*."))
                server_name = server_name.substring(2);
              xobj.server_name = server_name;
            }
          }

          this.cleanUpSanDNS(xobj);

          const multi = rclient.multi()
          multi.unlink(key) // delete before hmset in case number of keys is not same in old and new data
          multi.hmset(key, xobj)
          if (config.ssl.expires) {
            multi.expireat(key, parseInt(Date.now() / 1000) + config.ssl.expires);
          }
          await multi.execAsync()
          log.debug("SSL:CERT_ID Saved", key, xobj);
        } else {
          log.debug("SSL:CERT_ID flow.x509:notfound" + cert_id);
        }
      } catch(err) {
        log.error("Error saving SSL cert", cert_id, err)
      }

      // Cache
      let appCacheObj = {
        uid: obj.uid,
        host: obj.server_name,
        proto: "ssl",
        ip: dst
      };

      // this data can be used across processes, e.g., live flows in FireAPI
      if (appCacheObj.host && obj["id.orig_h"] && obj["id.resp_h"] && obj["id.orig_p"] && obj["id.resp_p"]) {
        const data = {};
        data[Constants.REDIS_HKEY_CONN_HOST] = appCacheObj.host;
        data.proto = "ssl";
        data.ip = dst;
        await conntrack.setConnEntries(obj["id.orig_h"], obj["id.orig_p"], obj["id.resp_h"], obj["id.resp_p"], "tcp", data, 600);
        this.depositeAppMap(obj["id.orig_h"], obj["id.orig_p"], obj["id.resp_h"], obj["id.resp_p"], appCacheObj);
      }
      /* this piece of code uses http to map dns */
      if (flowdir === "in" && obj.server_name) {
        await dnsTool.addReverseDns(obj.server_name, [dst]);
        await dnsTool.addDns(dst, obj.server_name, config.dns.expires);
      }
    } catch (e) {
      log.error("SSL:Error Unable to save", e, data);
    }
  }

  processX509Data(data) {
    try {
      let obj = JSON.parse(data);
      if (obj == null) {
        log.error("X509:Drop", data);
        return;
      }

      if (obj["certificate.subject"] && obj["certificate.subject"] === "CN=firewalla.encipher.io") {
        log.debug("X509:Self Ignoring", data);
        return;
      }

      let key = "flow:x509:" + (obj.hasOwnProperty("id") ? obj["id"] : obj["fingerprint"]);
      log.debug("X509:Save", key, obj);

      this.cleanUpSanDNS(obj);

      rclient.hmset(key, obj, (err, value) => {
        if (err == null) {
          if (config.x509.expires) {
            rclient.expireat(key, parseInt((+new Date) / 1000) + config.x509.expires);
          }
        } else {
          log.error("X509:Save:Error", err);
        }
      });
    } catch (e) {
      log.error("X509:Error Unable to save", e, data, e.stack);
    }
  }

  //{"ts":1465878273.418592,"host":"192.168.2.239"}
  processknownHostsData(data) {
    try {
      let obj = JSON.parse(data);
      if (obj == null) {
        log.error("KnownHosts:Drop", obj);
        return;
      }

      let ip = obj.host;
      if (!ip) {
        log.error("Invalid knownHosts entry:", obj);
        return;
      }

      if (sysManager.isMyIP(ip)) return

      const intfInfo = sysManager.getInterfaceViaIP(ip);
      if (!intfInfo || !intfInfo.uuid) {
        log.warn(`KnownHosts: Unable to find nif uuid, ${ip}`);
        return;
      }

      log.debug("Found a known host from host:", ip, intfInfo.name);

      l2.getMAC(ip, (err, mac) => {

        if (err || !mac) {
          // not found, ignore this host
          log.error("Not able to found mac address for host:", ip, mac);
          return;
        }

        let host = {
          ipv4: ip,
          ipv4Addr: ip,
          mac: mac,
          from: "broKnownHosts"
        };

        sem.emitEvent({
          type: "DeviceUpdate",
          message: `Found a device via bro known hosts ${host.ipv4} ${host.mac}`,
          host: host
        })

      });

    } catch (e) { }
  }

  //{"ts":1465969866.72256,"note":"Scan::Port_Scan","msg":"192.168.2.190 scanned at least 15 unique ports of host 192.168.2.108 in 0m1s","sub":"local","src":
  //"192.168.2.190","dst":"192.168.2.108","peer_descr":"bro","actions":["Notice::ACTION_LOG"],"suppress_for":3600.0,"dropped":false}


  async processNoticeData(data) {
    if(!fc.isFeatureOn("cyber_security")) return;
    try {
      let obj = JSON.parse(data);
      if (obj.note == null) {
        return;
      }

      // TODO: on DHCP mode, notice could be generated on ethx or ethx:0 first
      // and the other one will be suppressed. And we'll lost either device/dest info

      log.debug("Notice:Processing", obj);
      if (config.notice.ignore[obj.note] == null) {
        let strdata = JSON.stringify(obj);
        let key = "notice:" + obj.src;
        let redisObj = [key, obj.ts, strdata];
        log.debug("Notice:Save", redisObj);
        await rclient.zaddAsync(redisObj);
        let lh = null;
        let dh = null;

        // using src & dst by default, or id.orig_h & id.resp_h
        if (obj.src) {
          lh = obj.src;
          dh = obj.dst || (obj['id.orig_h'] == obj.src ? obj['id.resp_h'] : obj['id.orig_h']);
        } else {
          lh = obj['id.orig_h'];
          dh = obj['id.resp_h'];
        }

        lh = lh || "0.0.0.0";
        dh = dh || "0.0.0.0";

        // make sure lh points to local device
        if (lh && !sysManager.isLocalIP(lh)) {
          let tmp = lh;
          lh = dh;
          dh = tmp;
        }

        let message = obj.msg;
        let noticeType = obj.note;
        let timestamp = parseFloat(obj.ts);

        // TODO: create dedicate alarm type for each notice type
        let alarm = new Alarm.BroNoticeAlarm(timestamp, lh, noticeType, message, {
          "p.device.ip": lh,
          "p.dest.ip": dh
        });

        alarm = await broNotice.processNotice(alarm, obj);

        alarm && am2.enqueueAlarm(alarm);
      }
    } catch (e) {
      log.error("Notice:Error Unable to save", e, data);
    }
  }

  async processSignatureData(data) {
    const obj = JSON.parse(data);
    const {uid, sig_id, src_addr, src_port} = obj;
    if (!uid || !sig_id)
      return;
    this.addConnSignature(uid, sig_id);

    let isVPNSignature = false;

    if (sig_id == "wireguard-second-msg-sig") {
      log.info("Wireguard handshake signature detected", uid, sig_id, src_addr, src_port);
      isVPNSignature = true;
      
    } else if (sig_id.startsWith("openvpn-server-")) {
      log.info("openVPN handshake signature detected", uid, sig_id, src_addr, src_port);
      isVPNSignature = true;
    }

    if (isVPNSignature) {
      if (!src_addr || !src_port) {
        return;
      }
      let portObj = {};

      portObj.proto = "udp";
      portObj.start = src_port;
      portObj.end = src_port;
      categoryUpdater.blockAddress("vpn", src_addr, portObj, true);
    }
  }

  async getWanNicStats() {
    const wanIntfs = sysManager.getWanInterfaces();
    const result = {};
    for (const wanIntf of wanIntfs) {
      const name = wanIntf.name;
      const uuid = wanIntf.uuid;
      if (!wanIntf.ip_address || !wanIntf.gateway)
        continue;
      let rxBytes = await fsp.readFile(`/sys/class/net/${name}/statistics/rx_bytes`, 'utf8').then((result) => Number(result.trim())).catch((err) => {
        log.error(`Failed to read rx_bytes of ${name} in /sys/class/net`);
        return null;
      });
      let txBytes = await fsp.readFile(`/sys/class/net/${name}/statistics/tx_bytes`, 'utf8').then((result) => Number(result.trim())).catch((err) => {
        log.error(`Failed to read tx_bytes of ${name} in /sys/class/net`);
        return null;
      });
      if (rxBytes === null || txBytes === null)
        continue;
      const files = await fsp.readdir(`/sys/class/net/${name}`).catch((err) => {
        log.error(`Failed to read directory of ${name} in /sys/class/net`);
        return [];
      });
      for (const file of files) {
        // exclude bytes from upper vlan interfaces
        if (file.startsWith(`upper_${name}.`)) {
          rxBytes -= await fsp.readFile(`/sys/class/net/${name}/${file}/statistics/rx_bytes`, 'utf8').then((result) => Number(result.trim())).catch((err) => 0);
          txBytes -= await fsp.readFile(`/sys/class/net/${name}/${file}/statistics/tx_bytes`, 'utf8').then((result) => Number(result.trim())).catch((err) => 0);
        }
      }
      result[name] = {rxBytes: Math.max(0, rxBytes), txBytes: Math.max(0, txBytes), uuid};
    }
    return result;
  }

  async writeTrafficCache() {
    const toRecord = this.timeSeriesCache
    this.timeSeriesCache = { ts: Date.now() / 1000 }
    this.recordTraffic({}, 'global') // initialize global key, so wan traffic always get recoreded
    const duration = this.timeSeriesCache.ts - toRecord.ts
    const lastTS = Math.floor(toRecord.ts)

    const wanNicStats = await this.getWanNicStats();
    let wanNicRxBytes = 0;
    let wanNicTxBytes = 0;
    const wanTraffic = {};
    for (const iface of Object.keys(wanNicStats)) {
      if (this.wanNicStatsCache && this.wanNicStatsCache[iface]) {
        const uuid = wanNicStats[iface].uuid;
        // 1 mega bytes buffer in case there are multiple VLANs on a physical WAN port and bytes deduction may result in a negative result because statistics on different interfaces are not read at the same time
        const rxBytes = wanNicStats[iface].rxBytes >= this.wanNicStatsCache[iface].rxBytes - 1000000 ? Math.max(0, wanNicStats[iface].rxBytes - this.wanNicStatsCache[iface].rxBytes) : wanNicStats[iface].rxBytes;
        const txBytes = wanNicStats[iface].txBytes >= this.wanNicStatsCache[iface].txBytes - 1000000 ? Math.max(0, wanNicStats[iface].txBytes - this.wanNicStatsCache[iface].txBytes) : wanNicStats[iface].txBytes;
        if (uuid) {
          wanTraffic[uuid] = {rxBytes, txBytes};
        }
        wanNicRxBytes += rxBytes;
        wanNicTxBytes += txBytes;
      }
    }
    // a safe-check to filter abnormal rx/tx bytes spikes that may be caused by hardware bugs
    const threshold = config.threshold;
    if (wanNicRxBytes >= threshold.maxSpeed / 8 * duration) {
      log.warn('WAN rx exceeded', wanNicRxBytes, '>', threshold.maxSpeed, '/', duration)
      wanNicRxBytes = 0;
    }
    if (wanNicTxBytes >= threshold.maxSpeed / 8 * duration) {
      log.warn('WAN tx exceeded', wanNicRxBytes, '>', threshold.maxSpeed, '/', duration)
      wanNicTxBytes = 0;
    }
    this.wanNicStatsCache = wanNicStats;

    const isRouterMode = await mode.isRouterModeOn();
    if (isRouterMode) {
      for (const uuid of Object.keys(wanTraffic)) {
        if (wanTraffic[uuid].rxBytes)
          timeSeries.recordHit(`download:wan:${uuid}`, lastTS, wanTraffic[uuid].rxBytes)
        if (wanTraffic[uuid].txBytes)
          timeSeries.recordHit(`upload:wan:${uuid}`, lastTS, wanTraffic[uuid].txBytes)
      }
    }

    log.silly('toRecord', toRecord)
    for (const key in toRecord) {
      const subKey = key == 'global' ? '' : ':' + (key.endsWith('global') ? key.slice(0, -7) : key)
      const download = isRouterMode && key == 'global' ? wanNicRxBytes : toRecord[key].download;
      const upload = isRouterMode && key == 'global' ? wanNicTxBytes : toRecord[key].upload;
      download && timeSeries.recordHit('download' + subKey, lastTS, download)
      upload && timeSeries.recordHit('upload' + subKey, lastTS, upload)
      toRecord[key].intra && timeSeries.recordHit('intra' + subKey, lastTS, toRecord[key].intra)
      toRecord[key].conn && timeSeries.recordHit('conn' + subKey, lastTS, toRecord[key].conn)
      toRecord[key].dns && timeSeries.recordHit('dns' + subKey, lastTS, toRecord[key].dns)
    }

    timeSeries.exec()
  }

  recordTraffic(tuple, key) {
    if (!this.timeSeriesCache[key]) {
      this.timeSeriesCache[key] = { upload: 0, download: 0, intra: 0, conn: 0, dns: 0 }
    }
    for (const measure in tuple)
      this.timeSeriesCache[key][measure] += tuple[measure]
  }

  recordOutPort(mac, tmpspec) {
    log.debug("recordOutPort: ", tmpspec);
    const key = mac + ":" + tmpspec.dp;
    let ats = tmpspec.ts;  //last alarm time
    let oldData = null;
    let oldIndex = this.outportarray.findIndex((dataspec) => dataspec && dataspec.key == key);
    if (oldIndex > -1) {
      oldData = this.outportarray.splice(oldIndex, 1)[0];
      ats = oldData.ats;
    }
    let newData = {key: key, ts: tmpspec.ts, ats: ats};
    const expireInterval = 15 * 60; // 15 minute;
    if (oldData == null || (oldData != null && oldData.ats < newData.ts - expireInterval)) {
      newData.ats = newData.ts;  //set
      sem.sendEventToFireMain({
        type: "NewOutPortConn",
        flow: tmpspec,
        suppressEventLogging: true
      });
    }
    //put the latest port flow at the end
    this.outportarray.push(newData);
    let maxsize = 9000; //limit size to optimize memory and prevent extremes
    if (this.outportarray.length > maxsize) {
      this.outportarray.shift();
    }
  }
}

module.exports = new BroDetect()
