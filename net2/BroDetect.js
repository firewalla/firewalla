/*    Copyright 2016-2023 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient()
const platform = require('../platform/PlatformLoader.js').getPlatform();

const iptool = require("ip");

const sysManager = require('./SysManager.js');
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager();
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

const features = require('../net2/features.js')
const conntrack = platform.isAuditLogSupported() && features.isOn('conntrack') ?
  require('../net2/Conntrack.js') : { has: () => {}, set: () => {} }

const broNotice = require('../extension/bro/BroNotice.js');

const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();

const IdentityManager = require('./IdentityManager.js');

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const Accounting = require('../control/Accounting.js');
const accounting = new Accounting();

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const firewalla = require('../net2/Firewalla.js');
const Message = require('../net2/Message.js');

const mode = require('../net2/Mode.js')

const linux = require('../util/linux.js');

const l2 = require('../util/Layer2.js');

const timeSeries = require("../util/TimeSeries.js").getTimeSeries()

const sem = require('../sensor/SensorEventManager.js').getInstance();
const fc = require('../net2/config.js')
const config = fc.getConfig().bro

const APP_MAP_SIZE = 1000;
const FLOWSTASH_EXPIRES = config.conn.flowstashExpires;

const httpFlow = require('../extension/flow/HttpFlow.js');
const NetworkProfileManager = require('./NetworkProfileManager.js')
const _ = require('lodash');
const fsp = require('fs').promises;

const {formulateHostname, isDomainValid, delay} = require('../util/util.js');

const LRU = require('lru-cache');
const FlowAggrTool = require('./FlowAggrTool.js');
const Constants = require('./Constants.js');
const flowAggrTool = new FlowAggrTool();

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
      "knownHostsLog": [config.knownHosts.path, this.processknownHostsData]
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
    this.outportarray = [];

    let c = require('./MessageBus.js');
    this.publisher = new c();
    this.flowstash = {};
    this.flowstashExpires = Date.now() / 1000 + FLOWSTASH_EXPIRES;

    this.enableRecording = true
    this.activeMac = {};

    setInterval(() => {
      this._activeMacHeartbeat();
    }, 60000);

    this.lastNTS = null;

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
      if (entry.ipv4Addr && iptool.isV4Format(entry.ipv4Addr)) {
        host.ipv4 = entry.ipv4Addr;
        host.ipv4Addr = entry.ipv4Addr;
      }
      if (entry.ipv6Addr && Array.isArray(entry.ipv6Addr) && entry.ipv6Addr.length > 0) {
        host.ipv6Addr = entry.ipv6Addr;
      }
      if (host.ipv4Addr || host.ipv6Addr) {
        const intfInfo = host.ipv4Addr ? sysManager.getInterfaceViaIP(host.ipv4Addr) : host.ipv6Addr.map(ip6 => sysManager.getInterfaceViaIP(ip6)).find(i => i);
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
      const defaultWan = sysManager.getDefaultWanInterface();
      const defaultWanName = defaultWan && defaultWan.name;
      if (await mode.isDHCPModeOn() && defaultWanName && defaultWanName.startsWith("br")) {
        // probably need to add permanent ARP entries to arp table in bridge mode
        await l2.updatePermanentArpEntries(this.activeMac);
      }
    }
    this.activeMac = {};
  }

  async start() {
    this.initWatchers();
    if (firewalla.isMain()) {
      this.wanNicStatsCache = await this.getWanNicStats();
      this.timeSeriesCache = { global: { upload: 0, download: 0, conn: 0 } }
      sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async () => {
        this.wanNicStatsCache = await this.getWanNicStats();
      });
    }
  }

  depositeAppMap(key, value) {
    if (ValidateIPaddress(value.host)) {
      return;
    }

    if (sysManager.isOurCloudServer(value.host)) {
      return;
    }
    this.appmap.set(key, value);
  }

  withdrawAppMap(flowUid, preserve = false) {
    let obj = this.appmap.get(flowUid);
    if (obj) {
      delete obj['uid'];
      if (!preserve)
        this.appmap.del(flowUid);
    }
    return obj;
  }



  async processHttpData(data) {
    try {
      const obj = JSON.parse(data);
      // workaround for https://github.com/zeek/zeek/issues/1844
      if (obj.host && obj.host.match(/^\[?[0-9a-e]{1,4}$/)) {
        obj.host = obj['id.resp_h']
      }
      if (obj.host.endsWith(':')) {
        obj.host = obj.host.slice(0, -1)
      }
      httpFlow.process(obj);
      const appCacheObj = {
        uid: obj.uid,
        host: obj.host,
        proto: "http",
        ip: obj["id.resp_h"]
      };
      if (obj.host && obj["id.resp_p"] && obj.host.endsWith(`:${obj["id.resp_p"]}`)) {
        // since zeek 5.0, the host will contain port number if it is not a well-known port
        appCacheObj.host = obj.host.substring(0, obj.host.length - `:${obj["id.resp_p"]}`.length);
      }
      if (appCacheObj.host && appCacheObj.host.startsWith("[") && appCacheObj.host.endsWith("]"))
        // strip [] from an ipv6 address
        appCacheObj.host = appCacheObj.host.substring(1, appCacheObj.host.length - 1);
      this.depositeAppMap(obj.uid, appCacheObj);
    } catch (err) {}
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

  //{"ts":1464066236.121734,"uid":"CnCRV73J3F0nhWtBPb","id.orig_h":"192.168.2.221","id.orig_p":5353,"id.resp_h":"224.0.0.251","id.resp_p":5353,"proto":"udp","trans_id":0,"query":"jianyu-chens-iphone-6.local","qclass":32769,"qclass_name":"qclass-32769","qtype":255,"qtype_name":"*","rcode":0,"rcode_name":"NOERROR","AA":true,"TC":false,"RD":false,"RA":false,"Z":0,"answers":["jianyu-chens-iphone-6.local","jianyu-chens-iphone-6.local","jianyu-chens-iphone-6.local","jianyu-chens-iphone-6.local"],"TTLs":[120.0,120.0,120.0,120.0],"rejected":false}
  //{"ts":1482189510.68758,"uid":"Cl7FVE1EnC0fBhL8l7","id.orig_h":"2601:646:9100:74e0:e43e:adc7:6d48:76da","id.orig_p":53559,"id.resp_h":"2001:558:feed::1","id.resp_p":53,"proto":"udp","trans_id":12231,"query":"log-rts01-iad01.devices.nest.com","rcode":0,"rcode_name":"NOERROR","AA":false,"TC":false,"RD":false,"RA":true,"Z":0,"answers":["devices-rts01-production-331095621.us-east-1.elb.amazonaws.com","107.22.178.96","50.16.214.117","184.73.190.206","23.21.51.61"],"TTLs":[2.0,30.0,30.0,30.0,30.0],"rejected":false}

  async processDnsData(data) {
    try {
      let obj = JSON.parse(data);
      if (obj == null || obj["id.resp_p"] != 53) {
        return;
      }
      if (obj["id.resp_p"] == 53 && obj["id.orig_h"] != null && obj["answers"] && obj["answers"].length > 0 && obj["query"] && obj["query"].length > 0) {
        //await rclient.zaddAsync(`dns:`, Math.ceil(obj.ts), )
        if (this.lastDNS!=null) {
          if (this.lastDNS['query'] == obj['query']) {
            if (JSON.stringify(this.lastDNS['answers']) == JSON.stringify(obj["answers"])) {
              log.debug("processDnsData:DNS:Duplicated:", obj['query'], JSON.stringify(obj['answers']));
              return;
            }
          }
        }
        this.lastDNS = obj;
        if (obj["qtype_name"] === "PTR") {
          // reverse DNS query, the IP address is in the query parameter, the domain is in the answers
          if (obj["query"].endsWith(".in-addr.arpa")) {
            // ipv4 reverse DNS query
            const address = obj["query"].substring(0, obj["query"].length - ".in-addr.arpa".length).split('.').reverse().join('.');
            if (!address || !iptool.isV4Format(address) || iptool.isPrivate(address))
              return;
            const domains = obj["answers"].filter(answer => !firewalla.isReservedBlockingIP(answer) && !iptool.isV4Format(answer) && !iptool.isV6Format(answer) && isDomainValid(answer)).map(answer => formulateHostname(answer));
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

          const answers = obj['answers'].filter(answer => !firewalla.isReservedBlockingIP(answer) && (iptool.isV4Format(answer) || iptool.isV6Format(answer)));
          const cnames = obj['answers'].filter(answer => !firewalla.isReservedBlockingIP(answer) && !iptool.isV4Format(answer) && !iptool.isV6Format(answer) && isDomainValid(answer)).map(answer => formulateHostname(answer));
          const query = formulateHostname(obj['query']);

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
            sem.emitEvent({
              type: 'DestIPFound',
              ip: answer,
              host: query,
              from: "dns",
              suppressEventLogging: true
            });
          }
        }
      } else if (obj['id.orig_p'] == 5353 && obj['id.resp_p'] == 5353 && obj['answers'].length > 0) {
        let hostname = obj['answers'][0];
        let ip = obj['id.orig_p'];
        let key = "host:ip4:" + ip;
        log.debug("Dns:FindHostWithIP", key, ip, hostname);

        const host = await dnsManager.resolveLocalHostAsync(ip);
        if (host != null && host.mac != null && host.name == null && host.bname == null) {
          let changeset = {
            name: hostname,
            bname: hostname
          };
          //changeset['lastActiveTimestamp'] = Math.ceil(Date.now() / 1000);
          log.debug("Dns:Redis:Merge", key, changeset);
          await rclient.hmsetAsync("host:mac:" + host.mac, changeset)
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
      //log.info("Conn:Learned:Ip",ip,flowspec);
      // probably issue ping here for ARP cache and later used in IPv6DiscoverySensor
      if (!iptool.isV4Format(ip)) {
        // ip -6 neighbor may expire the ping pretty quickly, need to ping a few times to have sensors
        // pick up the new data
        log.info("Conn:Learned:Ip", "ping ", ip, flowspec);
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
  isMonitoring(ip, intf, identity) {
    if (!hostManager.isMonitoring())
      return false;

    if (identity) {
      if (!identity.isMonitoring()) return false
    }
    else {
      let hostObject = null;

      if (iptool.isV4Format(ip)) {
        hostObject = hostManager.getHostFast(ip);
      } else {
        if (iptool.isV6Format(ip)) {
          hostObject = hostManager.getHostFast6(ip);
        }
      }

      if (hostObject && !hostObject.isMonitoring()) {
        return false;
      }
    }

    if (intf) {
      const iface = sysManager.getInterface(intf);
      const uuid = iface && iface.uuid;
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (networkProfile && !networkProfile.isMonitoring()) {
        return false;
      }
    }

    return true;
  }

  isConnFlowValid(data, intf, lhost, identity) {
    let m = mode.getSetupModeSync()
    if (!m) {
      return true               // by default, always consider as valid
    }

    // ignore any traffic originated from walla itself, (walla is acting like router with NAT)
    if (sysManager.isMyIP(data["id.orig_h"]) ||
      sysManager.isMyIP(data["id.resp_h"])) {
      return false
    }

    if (sysManager.isMyIP6(data["id.orig_h"]) ||
      sysManager.isMyIP6(data["id.resp_h"])) {
      return false;
    }

    // ignore any devices' traffic who is set to monitoring off
    return this.isMonitoring(lhost, intf, identity)
  }

  isUDPtrafficAccountable(obj) {
    const host = obj["id.orig_h"];
    const dst = obj["id.resp_h"];
    const localOrig = obj["local_orig"];
    const localResp = obj["local_resp"];

    let deviceIP = null;

    if (localOrig) {
      deviceIP = host;
    } else {
      deviceIP = dst;
    }

    let device = null;

    if (iptool.isV4Format(deviceIP)) {
      device = hostManager.getHostFast(deviceIP);
    } else {
      device = hostManager.getHostFast6(deviceIP);
    }

    let mac = device && device.o && device.o.mac;

    return !accounting.isBlockedDevice(mac);
  }

  validateConnData(obj) {
    const threshold = config.threshold;
    const iptcpRatio = threshold.IPTCPRatio || 0.1;

    const missed_bytes = obj.missed_bytes;
    const resp_bytes = obj.resp_bytes;
    const orig_bytes = obj.orig_bytes;
    const orig_ip_bytes = obj.orig_ip_bytes;
    const resp_ip_bytes = obj.resp_ip_bytes;

    if (missed_bytes / (resp_bytes + orig_bytes) > threshold.missedBytesRatio) {
        log.debug("Conn:Drop:MissedBytes:RatioTooLarge", obj.conn_state, obj);
        return false;
    }

    if (orig_ip_bytes && orig_bytes &&
      (orig_ip_bytes > 1000 || orig_bytes > 1000) &&
      (orig_ip_bytes / orig_bytes) < iptcpRatio) {
      log.debug("Conn:Drop:IPTCPRatioTooLow:Orig", obj.conn_state, obj);
      return false;
    }

    if (resp_ip_bytes && resp_bytes &&
      (resp_ip_bytes > 1000 || resp_bytes > 1000) &&
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

      if(obj.resp_bytes > maxBytes) {
        log.debug("Conn:Drop:RespBytes:TooLarge", obj.conn_state, obj);
        return false;
      }

      if(obj.orig_bytes > maxBytes) {
        log.debug("Conn:Drop:OrigBytes:TooLarge", obj.conn_state, obj);
        return false;
      }
    }

    return true;
  }

  async processLongConnData(data) {
    return this.processConnData(data, true);
  }

  async processConnData(data, long = false) {
    try {
      let obj = JSON.parse(data);
      if (obj == null) {
        log.debug("Conn:Drop", obj);
        return;
      }

      // from zeek script heartbeat-flow
      if (obj.uid == '0' && obj['id.orig_h'] == '0.0.0.0' && obj["id.resp_h"] == '0.0.0.0') {
        await rclient.zaddAsync('flow:conn:00:00:00:00:00:00', Date.now() / 1000, data)
        await rclient.expireAsync('flow:conn:00:00:00:00:00:00', config.conn.expires)
        // return here so it doesn't go to flow stash
        return
      }

      if (obj.proto == "icmp") {
        return;
      }

      if (obj.service && obj.service == "dns") {
        return;
      }

      // drop layer 3
      if (obj.orig_ip_bytes == 0 && obj.resp_ip_bytes == 0) {
        log.debug("Conn:Drop:ZeroLength", obj.conn_state, obj);
        return;
      }

      if (obj.orig_bytes == null || obj.resp_bytes == null) {
        log.debug("Conn:Drop:NullBytes", obj);
        return;
      }

      const threshold = config.threshold;

      // drop layer 4
      if (obj.orig_bytes == 0 && obj.resp_bytes == 0) {
        log.debug("Conn:Drop:ZeroLength2", obj.conn_state, obj);
        return;
      }

      if(!this.validateConnData(obj)) {
        log.debug("Validate Failed", obj.conn_state, obj);
        return;
      }

      if (obj.proto && obj.proto == "tcp") {
        if (obj.resp_bytes > threshold.tcpZeroBytesResp && obj.orig_bytes == 0 && obj.conn_state == "SF") {
          log.error("Conn:Adjusted:TCPZero", obj.conn_state, obj);
          return;
        }
        else if (obj.orig_bytes > threshold.tcpZeroBytesOrig && obj.resp_bytes == 0 && obj.conn_state == "SF") {
          log.error("Conn:Adjusted:TCPZero", obj.conn_state, obj);
          return;
        }
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
      let flag;
      if (obj.proto == "tcp") {
        // beware that OTH may occur in long lasting connections intermittently
        // states count as normal: S1, S2, S3, SF, RSTO, RSTR, OTH
        if (obj.conn_state == "REJ" ||
          obj.conn_state == "RSTOS0" || obj.conn_state == "RSTRH" ||
          obj.conn_state == "SH" || obj.conn_state == "SHR" ||
          obj.conn_state == "S0") {
          log.debug("Conn:Drop:State:P1", obj.conn_state, data);
          flag = 's';
          // return directly for the traffic flagged as 's'
          return;
        }

        if ((obj.conn_state == "RSTR" || obj.conn_state == "RSTO") && obj.orig_pkts <= 10 && obj.resp_bytes == 0) {
          log.debug("Conn:Drop:TLS", obj.conn_state, data);
          // Likely blocked by TLS. In normal cases, the first packet is SYN, the second packet is ACK, the third packet is SSL client hello. conn_state will be "RSTR"
          // However, if zeek is listening on bridge interface, it will not capture tcp-reset from iptables. In this case, the remote server will send a FIN after 60 seconds and will be rejected by local device. The orig_pkts will be 4. conn_state will be "RSTO"
          // In rare cases, the originator will re-transmit data packets if the tcp-reset from iptables is not received. The orig_pkts will be more than 3 (or 4 if zeek listens on bridge). conn_state will be "RSTO" or "RSTR"
          return;
        }
      }

      const host = obj["id.orig_h"];
      const dst = obj["id.resp_h"];
      let flowdir = "in";
      let lhost = null;
      const origMac = obj["orig_l2_addr"];
      const respMac = obj["resp_l2_addr"];
      let localMac = null;
      let intfId = null;
      const localOrig = obj["local_orig"];
      const localResp = obj["local_resp"];

      log.debug("ProcessingConection:", obj.uid, host, dst);

      // fd: in, this flow initiated from inside
      // fd: out, this flow initated from outside, it is more dangerous

      if (localOrig == true && localResp == true) {
        flowdir = 'lo';
        lhost = host;
        localMac = origMac;
        //log.debug("Dropping both ip address", host,dst);
        log.debug("Local Traffic, both sides are in local network, ignored", obj);
        return;
      } else if (localOrig == true && localResp == false) {
        flowdir = "in";
        lhost = host;
        localMac = origMac;
      } else if (localOrig == false && localResp == true) {
        flowdir = "out";
        lhost = dst;
        localMac = respMac;
      } else {
        log.debug("Conn:Error:Drop", data, host, dst, localOrig, localResp);
        return;
      }

      const intfInfo = sysManager.getInterfaceViaIP(lhost);
      // ignore multicast IP
      try {
        if (sysManager.isMulticastIP4(dst, intfInfo && intfInfo.name)) {
          return;
        }
        if (obj["id.resp_p"] == 53 || obj["id.orig_p"] == 53) {
          return;
        }

        if (sysManager.isMyServer(dst) || sysManager.isMyServer(host)) {
          return;
        }
      } catch (e) {
        log.debug("Conn:Data:Error checking ulticast", e);
        return;
      }

      if (localMac && localMac.toUpperCase() === "FF:FF:FF:FF:FF:FF")
        return;

      const isIdentityIntf = intfInfo && intfInfo.name && (intfInfo.name == "tun_fwvpn" || intfInfo.name.startsWith("wg"))

      let localType = TYPE_MAC;
      let realLocal = null;
      let identity = null;
      if (!localMac && lhost) {
        identity = IdentityManager.getIdentityByIP(lhost);
        let retry = 2
        while (!identity && isIdentityIntf && !IdentityManager.isInitialized() && retry--) {
          await delay(10 * 1000)
          identity = IdentityManager.getIdentityByIP(lhost);
        }
        if (identity) {
          localMac = IdentityManager.getGUID(identity);
          realLocal = IdentityManager.getEndpointByIP(lhost);
          localType = TYPE_VPN;
        }
      }

      if (localMac && sysManager.isMyMac(localMac)) {
        // double confirm local mac is correct since bro may record Firewalla's MAC as local mac if packets are not fully captured due to ARP spoof leak
        if (!sysManager.isMyIP(lhost) && !(sysManager.isMyIP6(lhost))) {
          log.info("Discard incorrect local MAC address from bro log: ", localMac, lhost);
          localMac = null; // discard local mac from bro log since it is not correct
        }
      }

      // recored device heartbeat
      // as flows with invalid conn_state are removed, all flows here could be considered as valid
      // this should be done before device monitoring check, we still want heartbeat update from unmonitored devices
      if (localMac && localType === TYPE_MAC) {
        const ets = Math.round((obj.ts + obj.duration) * 100) / 100;
        // do not record into activeMac if it is earlier than 5 minutes ago, in case the IP address has changed in the last 5 minutes
        if (ets > Date.now() / 1000 - 300) {
          let macIPEntry = this.activeMac[localMac];
          if (!macIPEntry)
            macIPEntry = { ipv6Addr: [] };
          if (iptool.isV4Format(lhost)) {
            macIPEntry.ipv4Addr = lhost;
          } else if (iptool.isV6Format(lhost)) {
            macIPEntry.ipv6Addr.push(lhost);
          }
          this.activeMac[localMac] = macIPEntry;
        }
      }

      // ip address subnet mask calculation is cpu-intensive, move it after other light weight calculations
      if (!this.isConnFlowValid(obj, intfInfo && intfInfo.name, lhost, identity)) {
        return;
      }

      if (obj.proto === "udp" && !this.isUDPtrafficAccountable(obj)) {
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

      let outIntfId = null;
      if (obj['id.orig_h'] && obj['id.resp_h'] && obj['id.orig_p'] && obj['id.resp_p'] && obj['proto'])
        outIntfId = conntrack.getConnEntry(obj['id.orig_h'], obj['id.orig_p'], obj['id.resp_h'], obj['id.resp_p'], obj['proto']);
      if (outIntfId)
        conntrack.setConnEntry(obj['id.orig_h'], obj['id.orig_p'], obj['id.resp_h'], obj['id.resp_p'], obj['proto'], outIntfId); // extend the expiry in LRU

      // Long connection aggregation
      const uid = obj.uid
      if (long || this.activeLongConns.has(uid)) {
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

        if (obj.orig_bytes == 0 && obj.resp_bytes == 0) {
          log.debug("Conn:Drop:ZeroLength_Long", obj.conn_state, obj);
          return;
        }
      }

      if (intfInfo && intfInfo.uuid) {
        intfId = intfInfo.uuid;
      } else {
        log.error(`Conn: Unable to find nif uuid, ${lhost}`);
        intfId = '';
      }

      // Don't query MAC for IP from VPN interface, otherwise it will spawn many 'cat' processes in Layer2.js
      if (!localMac && !isIdentityIntf) {
        // this can also happen on older bro which does not support mac logging
        if (iptool.isV4Format(lhost)) {
          localMac = await l2.getMACAsync(lhost).catch((err) => {
            log.error("Failed to get MAC address from link layer for " + lhost, err);
            return;
          }); // Don't worry about performance issue, this function has internal cache
        }
        if (!localMac) {
          localMac = await hostTool.getMacByIPWithCache(lhost).catch((err) => {
            log.error("Failed to get MAC address from cache for " + lhost, err);
          });
        }
      }

      if (!localMac || localMac.constructor.name !== "String") {
        localMac = null;
        log.warn('NO LOCAL MAC! Drop flow', data)
        return
      }

      if (localMac)
        localMac = localMac.toUpperCase();

      if (Number(obj.orig_bytes) > threshold.logLargeBytesOrig) {
        log.error("Conn:Debug:Orig_bytes:", obj.orig_bytes, obj);
      }
      if (Number(obj.resp_bytes) > threshold.logLargeBytesResp) {
        log.error("Conn:Debug:Resp_bytes:", obj.resp_bytes, obj);
      }

      // flowstash is the aggradation of flows within FLOWSTASH_EXPIRES seconds
      let now = Date.now() / 1000; // keep it as float, reduce the same score flows
      let flowspecKey = `${host}:${dst}:${intfId}:${outIntfId || ""}:${obj['id.resp_p'] || ""}:${flowdir}`;

      const tmpspec = {
        ts: obj.ts, // ts stands for start timestamp
        ets: Math.round((obj.ts + obj.duration) * 100) / 100 , // ets stands for end timestamp
        _ts: now, // _ts is the last time updated
        sh: host, // source
        dh: dst, // dstination
        ob: Number(obj.orig_bytes), // transfer bytes
        rb: Number(obj.resp_bytes),
        ct: 1, // count
        fd: flowdir, // flow direction
        lh: lhost, // this is local ip address
        intf: intfId, // intf id
        oIntf: outIntfId, // egress intf id
        du: obj.duration,
        af: {}, //application flows
        pr: obj.proto,
        f: flag,
        uids: [obj.uid],
        ltype: localType
      };

      for (const type of Object.keys(Constants.TAG_TYPE_MAP)){
        const config = Constants.TAG_TYPE_MAP[type];
        const flowKey = config.flowKey;
        const tags = [];
        if (localMac) {
          const hostInfo = hostManager.getHostFastByMAC(localMac);
          switch (localType) {
            case TYPE_MAC: {
              if (hostInfo)
                tags.push(...await hostInfo.getTags(type));
              break;
            }
            case TYPE_VPN: {
              if (identity) {
                tags.push(...await identity.getTags(type));
                break;
              }
            }
            default:
          }

          if (intfId !== '') {
            const networkProfile = NetworkProfileManager.getNetworkProfile(intfId);
            if (networkProfile)
              tags.push(...await networkProfile.getTags(type));
          }
          tmpspec[flowKey] = _.uniq(tags);
        }
      }

      if (identity)
        tmpspec.guid = IdentityManager.getGUID(identity);
      if (realLocal)
        tmpspec.rl = realLocal;

      if (obj['id.orig_p']) tmpspec.sp = [obj['id.orig_p']];
      if (obj['id.resp_p']) tmpspec.dp = obj['id.resp_p'];

      // might be blocked UDP packets, checking conntrack
      // blocked connections don't leave a trace in conntrack
      if (tmpspec.pr == 'udp' && (tmpspec.ob == 0 || tmpspec.rb == 0)) {
        try {
          if (!outIntfId) {
            log.verbose('Dropping blocked UDP', tmpspec)
            return
          }
        } catch (err) {
          log.error('Failed to fetch audit logs', err)
        }
      }

      const afobj = this.withdrawAppMap(obj.uid, long || this.activeLongConns.has(obj.uid));
      let afhost
      if (afobj && afobj.host && flowdir === "in") { // only use information in app map for outbound flow, af describes remote site
        tmpspec.af[afobj.host] = afobj;
        afhost = afobj.host
        delete afobj.host;
      }

      // rotate flowstash early to make sure current flow falls in the next stash
      // actually rotation is delayed, should be 
      if (now > this.flowstashExpires)
        this.rotateFlowStash(now)

      this.indicateNewFlowSpec(tmpspec);

      const traffic = [tmpspec.ob, tmpspec.rb]
      if (tmpspec.fd == 'in') traffic.reverse()

      // use now instead of the start time of this flow
      await this.recordTraffic(new Date() / 1000, ...traffic, tmpspec.ct, localMac);
      if (intfId) {
        await this.recordTraffic(new Date() / 1000, ...traffic, tmpspec.ct, 'intf:' + intfId, true);
      }
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        const flowKey = config.flowKey;
        for (const tag of tmpspec[flowKey]) {
          await this.recordTraffic(new Date() / 1000, ...traffic, tmpspec.ct, 'tag:' + tag, true);
        }
      }

      // Single flow is written to redis first to prevent data loss
      // will be aggregated on flow stash expiration and removed in most cases
      let key = "flow:conn:" + tmpspec.fd + ":" + localMac;
      let strdata = JSON.stringify(tmpspec);

      // beware that now/_ts is used as score in flow:conn:* zset, since now is always monotonically increasing
      let redisObj = [key, now, strdata];
      log.debug("Conn:Save:Temp", redisObj);

      // add mac to flowstash (but not redis)
      tmpspec.mac = localMac

      if (tmpspec.fd == 'out') {
        this.recordOutPort(localMac, tmpspec);
      }

      await rclient.zaddAsync(redisObj).catch(
        err => log.error("Failed to save tmpspec: ", tmpspec, err)
      )
      await flowAggrTool.recordDeviceLastFlowTs(localMac, now);
      tmpspec.mac = localMac; // record the mac address
      const remoteIPAddress = (tmpspec.lh === tmpspec.sh ? tmpspec.dh : tmpspec.sh);
      let remoteHost = null;
      if (afhost && _.isObject(afobj) && afobj.ip === remoteIPAddress) {
        remoteHost = afhost;
      }

      let flowspec = this.flowstash[flowspecKey];
      if (flowspec == null) {
        flowspec = tmpspec
        this.flowstash[flowspecKey] = flowspec;
        log.debug("Conn:FlowSpec:Create:", flowspec);
      } else {
        flowspec.ob += Number(obj.orig_bytes);
        flowspec.rb += Number(obj.resp_bytes);
        flowspec.ct += 1;
        if (flowspec.ts > obj.ts) {
          // update start timestamp
          flowspec.ts = obj.ts;
        }
        if (flowspec.ets < tmpspec.ets) {
          // update end timestamp
          flowspec.ets = tmpspec.ets;
        }
        // update last time updated
        flowspec._ts = now;
        // TBD: How to define and calculate the duration of flow?
        //      The total time of network transfer?
        //      Or the length of period from the beginning of the first to the end of last flow?
        // Fow now, we take both into consideration, and the total duration should be the lesser of the two
        flowspec.du = Math.round(Math.min(flowspec.ets - flowspec.ts, flowspec.du + obj.duration) * 100) / 100;
        if (flag) {
          flowspec.f = flag;
        }
        flowspec.uids.includes(obj.uid) || flowspec.uids.push(obj.uid)

        if (obj['id.orig_p'] && !flowspec.sp.includes(obj['id.orig_p'])) {
          flowspec.sp.push(obj['id.orig_p']);
        }
        if (afhost && !flowspec.af[afhost]) {
          flowspec.af[afhost] = afobj;
        }
      }


      setTimeout(() => {
        sem.emitEvent({
          type: 'DestIPFound',
          ip: remoteIPAddress,
          host: remoteHost,
          fd: tmpspec.fd,
          flow: Object.assign({}, tmpspec, {ip: remoteIPAddress, host: remoteHost, mac: localMac}),
          from: "flow",
          suppressEventLogging: true,
          mac: localMac
        });
        if (realLocal) {
          sem.emitEvent({
            type: 'DestIPFound',
            from: "VPN_endpoint",
            ip: realLocal.startsWith("[") && realLocal.includes("]:") ? realLocal.substring(1, realLocal.indexOf("]:")) : realLocal.split(":")[0],
            suppressEventLogging: true
          });
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

  rotateFlowStash(now) {
    let sstart = this.flowstashExpires - FLOWSTASH_EXPIRES;
    let send = this.flowstashExpires;

    try {
      // Every FLOWSTASH_EXPIRES seconds, save aggregated flowstash into redis and empties flowstash
      let stashed = {};
      log.info("Processing Flow Stash");

      for (const specKey in this.flowstash) {
        const spec = this.flowstash[specKey];
        if (!spec.mac)
          continue;
        try {
          // try resolve host info for previous flows again here
          for (const uid of spec.uids) {
            const afobj = this.withdrawAppMap(uid);
            if (spec.fd === "in" && afobj && afobj.host && !spec.af[afobj.host]) {
              spec.af[afobj.host] = afobj;
              delete afobj['host'];
            }
          }
        } catch (e) {
          log.error("Conn:Save:AFMAP:EXCEPTION", e);
        }

        const key = "flow:conn:" + spec.fd + ":" + spec.mac;
        // not storing mac (as it's in key) to squeeze memory
        delete spec.mac
        const strdata = JSON.stringify(spec);
        // _ts is the last time this flowspec is updated
        const redisObj = [key, spec._ts, strdata];
        if (stashed[key]) {
          stashed[key].push(redisObj);
        } else {
          stashed[key] = [redisObj];
        }

      }

      setTimeout(async () => {
        log.info("Conn:Save:Summary", sstart, send, this.flowstashExpires);
        for (let key in stashed) {
          let stash = stashed[key];
          log.debug("Conn:Save:Summary:Wipe", key, "Resolved To:", stash.length);

          let transaction = [];
          transaction.push(['zremrangebyscore', key, sstart, send]);
          stash.forEach(robj => {
            if (robj._ts < sstart || robj._ts > send) log.warn('Stashed flow out of range', sstart, send, robj)
            transaction.push(['zadd', robj])
          })
          if (config.conn.expires) {
            transaction.push(['expireat', key, parseInt(new Date / 1000) + config.conn.expires])
          }

          try {
            await rclient.multi(transaction).execAsync();
            log.debug("Conn:Save:Removed", key, sstart, send);
          } catch (err) {
            log.error("Conn:Save:Error", err);
          }
        }
      }, FLOWSTASH_EXPIRES * 1000);

      this.flowstashExpires = now + FLOWSTASH_EXPIRES;
      this.flowstash = {};
    } catch (e) {
      log.error("Error rotating flowstash", sstart, send, e);
    }
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
      let key = "host:ext.x509:" + dst;
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
          await rclient.unlinkAsync(key) // delete before hmset in case number of keys is not same in old and new data
          await rclient.hmsetAsync(key, xobj)
          if (config.ssl.expires) {
            await rclient.expireatAsync(key, parseInt(Date.now() / 1000) + config.ssl.expires);
          }
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

          await rclient.unlinkAsync(key) // delete before hmset in case number of keys is not same in old and new data
          await rclient.hmsetAsync(key, xobj)
          if (config.ssl.expires) {
            await rclient.expireatAsync(key, parseInt((+new Date) / 1000) + config.ssl.expires);
          }
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

      this.depositeAppMap(appCacheObj.uid, appCacheObj);
      /* this piece of code uses http to map dns */
      if (flowdir === "in" && obj.server_name) {
        await dnsTool.addReverseDns(obj.server_name, [dst]);
        await dnsTool.addDns(dst, obj.server_name, config.dns.expires);
      }
    } catch (e) {
      log.error("SSL:Error Unable to save", e, e.stack, data);
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
        if (config.notice.expires) {
          await rclient.expireatAsync(key, parseInt((+new Date) / 1000) + config.notice.expires);
        }
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

  async recordTraffic(ts, inBytes, outBytes, conn, mac, ignoreGlobal = false) {
    if (this.enableRecording) {


      const normalizedTS = Math.floor(Math.floor(Number(ts)) / 10) // only record every 10 seconds

      // lastNTS starts with null and assigned with normalizedTS every 10s
      if (this.lastNTS != normalizedTS) {
        const toRecord = this.timeSeriesCache

        const duration = (normalizedTS - this.lastNTS) * 10;
        this.lastNTS = normalizedTS
        this.fullLastNTS = Math.floor(ts)
        this.timeSeriesCache = { global: { upload: 0, download: 0, conn: 0 } }

        const wanNicStats = await this.getWanNicStats();
        let wanNicRxBytes = 0;
        let wanNicTxBytes = 0;
        const wanTraffic = {};
        for (const iface of Object.keys(wanNicStats)) {
          if (this.wanNicStatsCache && this.wanNicStatsCache[iface]) {
            const uuid = wanNicStats[iface].uuid;
            const rxBytes = wanNicStats[iface].rxBytes >= this.wanNicStatsCache[iface].rxBytes ? wanNicStats[iface].rxBytes - this.wanNicStatsCache[iface].rxBytes : wanNicStats[iface].rxBytes;
            const txBytes = wanNicStats[iface].txBytes >= this.wanNicStatsCache[iface].txBytes ? wanNicStats[iface].txBytes - this.wanNicStatsCache[iface].txBytes : wanNicStats[iface].txBytes;
            if (uuid) {
              wanTraffic[uuid] = {rxBytes, txBytes};
            }
            wanNicRxBytes += rxBytes;
            wanNicTxBytes += txBytes;
          }
        }
        // a safe-check to filter abnormal rx/tx bytes spikes that may be caused by hardware bugs
        const threshold = config.threshold;
        if (wanNicRxBytes >= threshold.maxSpeed / 8 * duration)
          wanNicRxBytes = 0;
        if (wanNicTxBytes >= threshold.maxSpeed / 8 * duration)
          wanNicTxBytes = 0;
        this.wanNicStatsCache = wanNicStats;

        const isRouterMode = await mode.isRouterModeOn();
        if (isRouterMode) {
          for (const uuid of Object.keys(wanTraffic)) {
            timeSeries
              .recordHit(`download:wan:${uuid}`, this.fullLastNTS, wanTraffic[uuid].rxBytes)
              .recordHit(`upload:wan:${uuid}`, this.fullLastNTS, wanTraffic[uuid].txBytes)
          }
        }

        for (const key in toRecord) {
          const subKey = key == 'global' ? '' : ':' + key
          const download = isRouterMode && key == 'global' ? wanNicRxBytes : toRecord[key].download;
          const upload = isRouterMode && key == 'global' ? wanNicTxBytes : toRecord[key].upload;
          log.debug("Store timeseries", this.fullLastNTS, key, download, upload, toRecord[key].conn)
          timeSeries
            .recordHit('download' + subKey, this.fullLastNTS, download)
            .recordHit('upload' + subKey, this.fullLastNTS, upload)
            .recordHit('conn' + subKey, this.fullLastNTS, toRecord[key].conn)
        }
        timeSeries.exec()
      }

      // append current status
      if (!ignoreGlobal) {
        this.timeSeriesCache.global.download += Number(inBytes)
        this.timeSeriesCache.global.upload += Number(outBytes)
        this.timeSeriesCache.global.conn += Number(conn)
      }

      if (!this.timeSeriesCache[mac]) {
        this.timeSeriesCache[mac] = { upload: 0, download: 0, conn: 0 }
      }
      this.timeSeriesCache[mac].download += Number(inBytes)
      this.timeSeriesCache[mac].upload += Number(outBytes)
      this.timeSeriesCache[mac].conn += Number(conn)
    }
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
