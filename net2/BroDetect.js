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

const log = require('./logger.js')(__filename);

const Tail = require('../vendor_lib/always-tail.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const iptool = require("ip");

const sysManager = require('./SysManager.js');
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager();
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

const broNotice = require('../extension/bro/BroNotice.js');

const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();

const VPNProfileManager = require('./VPNProfileManager.js');
const Constants = require('./Constants.js');

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const Accounting = require('../control/Accounting.js');
const accounting = new Accounting();

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const firewalla = require('../net2/Firewalla.js');

const mode = require('../net2/Mode.js')

const linux = require('../util/linux.js');

const l2 = require('../util/Layer2.js');

const timeSeries = require("../util/TimeSeries.js").getTimeSeries()

const sem = require('../sensor/SensorEventManager.js').getInstance();
const fc = require('../net2/config.js')
let appmapsize = 200;
let FLOWSTASH_EXPIRES;

const httpFlow = require('../extension/flow/HttpFlow.js');
const NetworkProfileManager = require('./NetworkProfileManager.js')
const _ = require('lodash');
const Message = require('../net2/Message.js');

const {formulateHostname, isDomainValid} = require('../util/util.js');

const TYPE_MAC = "mac";
const TYPE_VPN = "vpn";

const PREFIX_VPN = "vpn:";
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

var instances = {};

function ValidateIPaddress(ipaddress) {
  if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
    return (true)
  }
  return (false)
}

module.exports = class {
  initWatchers() {
    log.debug("Initializing watchers", this.config.bro);
    let failed = false
    if (this.intelLog == null) {
      this.intelLog = new Tail(this.config.bro.intel.path, '\n');
      if (this.intelLog != null) {
        log.debug("Initializing watchers: intelog initialized:", this.config.bro.intel.path);
        this.intelLog.on('line', (data) => {
          log.debug("Detect:Intel ", data);
          this.processIntelData(data);
        });
        this.intelLog.on('error', (err) => {
          log.error("Error while reading intel log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.noticeLog == null) {
      this.noticeLog = new Tail(this.config.bro.notice.path, '\n');
      if (this.noticeLog != null) {
        log.debug("Initializing watchers: noticeLog initialized", this.config.bro.notice.path);
        this.noticeLog.on('line', (data) => {
          log.debug("Detect:Notice", data);
          this.processNoticeData(data);
        });
        this.noticeLog.on('error', (err) => {
          log.error("Error while reading notice log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.dnsLog == null) {
      this.dnsLog = new Tail(this.config.bro.dns.path, '\n');
      if (this.dnsLog != null) {
        log.debug("Initializing watchers: dnslog initialized", this.config.bro.dns.path);
        this.dnsLog.on('line', (data) => {
          this.processDnsData(data);
        });
        this.dnsLog.on('error', (err) => {
          log.error("Error while reading dns log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.softwareLog == null) {
      this.softwareLog = new Tail(this.config.bro.software.path, '\n');
      if (this.softwareLog != null) {
        log.debug("Initializing watchers: software initialized", this.config.bro.software.path);
        this.softwareLog.on('line', (data) => {
          log.debug("Detect:Software", data);
          this.processSoftwareData(data);
        });
        this.softwareLog.on('error', (err) => {
          log.error("Error while reading software log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.httpLog == null) {
      this.httpLog = new Tail(this.config.bro.http.path, '\n');
      if (this.httpLog != null) {
        log.debug("Initializing watchers: http initialized", this.config.bro.http.path);
        this.httpLog.on('line', (data) => {
          log.debug("Detect:Http", data);
          httpFlow.process(data);
        });
        this.httpLog.on('error', (err) => {
          log.error("Error while reading http log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.sslLog == null) {
      this.sslLog = new Tail(this.config.bro.ssl.path, '\n');
      if (this.sslLog != null) {
        log.debug("Initializing watchers: sslinitialized", this.config.bro.ssl.path);
        this.sslLog.on('line', (data) => {
          log.debug("Detect:SSL", data);
          this.processSslData(data);
        });
        this.sslLog.on('error', (err) => {
          log.error("Error while reading ssl log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.connLog == null) {
      this.connLog = new Tail(this.config.bro.conn.path, '\n');
      if (this.connLog != null) {
        log.debug("Initializing watchers: connInitialized", this.config.bro.conn.path);
        this.connLog.on('line', async (data) => {
          await this.processConnData(data);
        });
        this.connLog.on('error', (err) => {
          log.error("Error while reading conn log", err.message);
        });
      } else {
        failed = true
      }
    }
    if (this.connLongLog == null) {
      this.connLongLog = new Tail(this.config.bro.connLong.path, '\n');
      if (this.connLongLog != null) {
        log.debug("Initializing watchers: connLongInitialized", this.config.bro.connLong.path);
        this.connLongLog.on('line', async (data) => {
          await this.processConnData(data, true);
        });
        this.connLongLog.on('error', (err) => {
          log.error("Error while reading conn long log", err.message);
        });
      } else {
        failed = true
      }
    }
    if (this.connLogdev == null) {
      this.connLogdev = new Tail(this.config.bro.conn.pathdev, '\n');
      if (this.connLogdev != null) {
        log.debug("Initializing watchers: connInitialized", this.config.bro.conn.pathdev);
        this.connLogdev.on('line', async (data) => {
          await this.processConnData(data);
        });
        this.connLogdev.on('error', (err) => {
          log.error("Error while reading conn dev log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.x509Log == null) {
      this.x509Log = new Tail(this.config.bro.x509.path, '\n');
      if (this.x509Log != null) {
        log.debug("Initializing watchers: X509 Initialized", this.config.bro.x509.path);
        this.x509Log.on('line', (data) => {
          this.processX509Data(data);
        });
        this.x509Log.on('error', (err) => {
          log.error("Error while reading x509 log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (this.knownHostsLog == null) {
      this.knownHostsLog = new Tail(this.config.bro.knownHosts.path, '\n');
      if (this.knownHostsLog != null) {
        log.debug("Initializing watchers: knownHosts Initialized", this.config.bro.knownHosts.path);
        this.knownHostsLog.on('line', (data) => {
          this.processknownHostsData(data);
        });
        this.knownHostsLog.on('error', (err) => {
          log.error("Error while reading known hosts log", err.message);
        });
      } else {
        failed = true
      }
    }

    if (failed) {
      setTimeout(this.initWatchers, 5000);
    }
  }

  constructor(name, config) {
    if (instances[name] != null) {
      return instances[name];
    } else {
      this.config = config;
      FLOWSTASH_EXPIRES = this.config.bro.conn.flowstashExpires;
      this.appmap = {};
      this.apparray = [];
      this.connmap = {};
      this.connarray = [];
      this.outportarray = [];

      this.initWatchers();
      instances[name] = this;
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

      this.activeLongConns = {}
      setInterval(() => {
        const now = new Date() / 1000
        for (const uid of Object.keys(this.activeLongConns)) {
          const lastTick = this.activeLongConns[uid].ts + this.activeLongConns[uid].duration
          if (lastTick + this.config.bro.connLong.expires < now)
            delete this.activeLongConns[uid]
        }
      }, 3600 * 15)
    }
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
        const intfInfo = host.ipv4Addr ? sysManager.getInterfaceViaIP4(host.ipv4Addr) : sysManager.getInterfaceViaIP6(host.ipv6Addr);
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
    this.activeMac = {};
  }

  start() {
    if (this.intelLog) {
      log.debug("Start watching intel log");
      this.intelLog.watch();
    }
    if (this.noticeLog) {
      log.debug("Start watching notice log");
      this.noticeLog.watch();
    }
  }

  addConnMap(key, value) {
    if (this.connmap[key] != null) {
      return;
    }
    log.debug("CONNMAP_ARRAY", this.connarray.length, key, value);
    this.connarray.push(value);
    this.connmap[key] = value;
    let mapsize = 9000;
    if (this.connarray.length > mapsize) {
      let removed = this.connarray.splice(0, this.connarray.length - mapsize);
      for (let i in removed) {
        delete this.connmap[removed[i]['uid']];
      }
    }
  }

  lookupConnMap(key) {
    let obj = this.connmap[key];
    if (obj) {
      delete this.connmap[key];
      let index = this.connarray.indexOf(obj);
      if (index > -1) {
        this.connarray.splice(index, 1);
      }
    }
    return obj;
  }

  addAppMap(key, value) {
    if (ValidateIPaddress(value.host)) {
      return;
    }

    if (sysManager.isOurCloudServer(value.host)) {
      return;
    }

    if (this.appmap[key] != null) {
      return;
    }

    log.debug("APPMAP_ARRAY", this.apparray.length, key, value.host, "length:", this.apparray.length);
    this.apparray.push(value);
    this.appmap[key] = value;
    if (this.apparray.length > appmapsize) {
      let removed = this.apparray.splice(0, this.apparray.length - appmapsize);
      for (let i in removed) {
        delete this.appmap[removed[i]['uid']];
      }
    }
  }

  lookupAppMap(flowUid) {
    let obj = this.appmap[flowUid];
    if (obj) {
      delete obj['uid'];
      delete this.appmap[flowUid];
      let index = this.apparray.indexOf(obj);
      if (index > -1) {
        this.apparray.splice(index, 1);
      }
    }
    return obj;
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
      if (this.config.bro.intel.ignore[obj.note] == null) {
        let strdata = JSON.stringify(obj);
        let key = "intel:" + obj['id.orig_h'];
        let redisObj = [key, obj.ts, strdata];
        log.debug("Intel:Save", redisObj);
        rclient.zadd(redisObj, (err, response) => {
          if (err) {
            log.error("Intel:Save:Error", err);
          } else {
            if (this.config.bro.intel.expires) {
              rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.intel.expires);
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
              await dnsTool.addReverseDns(domain, [address]);
              await dnsTool.addDns(address, domain, this.config.bro.dns.expires);
            }
            sem.emitEvent({
              type: 'DestIPFound',
              ip: address,
              suppressEventLogging: true
            });
          }
        } else {
          if (!isDomainValid(obj["query"]))
            return;

          const answers = obj['answers'].filter(answer => !firewalla.isReservedBlockingIP(answer) && (iptool.isV4Format(answer) || iptool.isV6Format(answer)));
          const cnames = obj['answers'].filter(answer => !firewalla.isReservedBlockingIP(answer) && !iptool.isV4Format(answer) && !iptool.isV6Format(answer) && isDomainValid(answer)).map(answer => formulateHostname(answer));
          const query = formulateHostname(obj['query']);

          // record reverse dns as well for future reverse lookup
          await dnsTool.addReverseDns(query, answers);
          for (const cname of cnames)
            await dnsTool.addReverseDns(cname, answers);

          for (const answer of answers) {
            await dnsTool.addDns(answer, query, this.config.bro.dns.expires);
            for (const cname of cnames) {
              await dnsTool.addDns(answer, cname, this.config.bro.dns.expires);
            }
            sem.emitEvent({
              type: 'DestIPFound',
              ip: answer,
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
      if (fc.isFeatureOn("acl_audit")) {
        const record = {
          ts: Math.round(obj.ts * 1000) / 1000,
          // rtt (round trip time) is usually very short here, ignore it
          sh: obj["id.orig_h"],   // source host
          dh: obj["id.resp_h"],   // destination host
          dp: obj["id.resp_p"],   // destination port
          dn: obj["query"],       // domain name
          qc: obj["qclass"],      // resource record (RR) class
          qt: obj["qtype"],       // resource record (RR) type
          rc: obj["rcode"],       // RCODE
        };
        // detect DNS level block (NXDOMAIN) in dns log
        if (
          obj["rcode"] == 3 /*NXDOMAIN*/ &&
          (obj["qtype_name"] === "A" || obj["qtype_name"] === "AAAA") &&
          obj["id.resp_p"] == 53 &&
          obj["id.orig_h"] != null &&
          _.isString(obj["query"]) &&
          obj["query"].length > 0 &&
          !sysManager.isMyIP(obj["id.orig_h"]) &&
          !sysManager.isMyIP6(obj["id.orig_h"])
        ) {
          sem.emitEvent({
            type: Message.MSG_ACL_DNS_NXDOMAIN,
            record,
            suppressEventLogging: true
          });
        } else {
          Object.assign(record, {
            ans: obj.answers
          })
          sem.emitEvent({
            type: Message.MSG_ACL_DNS_UNCATEGORIZED,
            record,
            suppressEventLogging: true
          });
        }
      }
    } catch (e) {
      log.error("Detect:Dns:Error", e, data, e.stack);
    }
  }

  //{"ts":1463941806.971767,"host":"192.168.2.106","software_type":"HTTP::BROWSER","name":"UPnP","version.major":1,"version.minor":0,"version.addl":"DLNADOC/1","unparsed_version":"UPnP/1.0 DLNADOC/1.50 Platinum/1.0.4.11"}

  processSoftwareData(data) {
    try {
      let obj = JSON.parse(data);
      if (obj == null || obj["host"] == null || obj['name'] == null) {
        log.error("Software:Drop", obj);
        return;
      }
      let key = "software:ip:" + obj['host'];
      rclient.zadd([key, obj.ts, JSON.stringify(obj)], (err, value) => {
        if (err == null) {
          if (this.config.bro.software.expires) {
            rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.software.expires);
          }
        }

      });
    } catch (e) {
      log.error("Detect:Software:Error", e, data, e.stack);
    }
  }


  // We now seen a new flow coming ... which might have a new ip getting discovered, lets take care of this
  indicateNewFlowSpec(flowspec) {
    let ip = flowspec.lh;
    if (this.pingedIp == null) {
      this.pingedIp = {};
      setTimeout(() => {
        this.pingedIp = null;
      }, 1000 * 60 * 60 * 24);
    }
    if (sysManager.ipLearned(ip) == false && this.pingedIp[ip] == null) {
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
        this.pingedIp[ip] = true;
      }
    }
  }

  /*
   * {"ts":1464303791.790091,"uid":"CosE7p2gSFbxvdRig2","id.orig_h":"fe80::6a5b:35ff:fec9:b9cb","id.orig_p":143,"id.resp_h":"ff02::16","id.resp_p":0,"proto":"icmp","conn_state":"OTH","local_orig":false,"local_resp":false,"missed_bytes":0,"orig_pkts":1,"orig_ip_bytes":196,"resp_pkts":0,"resp_ip_bytes":0,"tunnel_parents":[]}

    2016-05-27T06:00:34.110Z - debug: Conn:Save 0=flow:conn:in:192.168.2.232, 1=1464328691.497809, 2={"ts":1464328691.497809,"uid":"C3Lb6y27y6fEbngara","id.orig_h":"192.168.2.232","id.orig_p":58137,"id.resp_h":"216.58.194.194","id.resp_p":443,"proto":"tcp","service":"ssl","duration":136.54717,"orig_bytes":1071,"resp_bytes":5315,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":48,"orig_ip_bytes":4710,"resp_pkts":34,"resp_ip_bytes":12414,"tunnel_parents":[]}
  */

  isMonitoring(ip) {
    if (!hostManager.isMonitoring())
      return false;
    let hostObject = null;
    let networkProfile = null;
    let vpnProfile = null;
    if (iptool.isV4Format(ip)) {
      hostObject = hostManager.getHostFast(ip);
      const iface = sysManager.getInterfaceViaIP4(ip);
      const uuid = iface && iface.uuid;
      networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      const cn = VPNProfileManager.getProfileCNByVirtualAddr(ip);
      if (cn)
        vpnProfile = VPNProfileManager.getVPNProfile(cn);
    } else {
      if (iptool.isV6Format(ip)) {
        hostObject = hostManager.getHostFast6(ip);
        const iface = sysManager.getInterfaceViaIP6(ip);
        const uuid = iface && iface.uuid;
        networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      }
    }

    if (hostObject && !hostObject.isMonitoring()) {
      return false;
    }
    if (networkProfile && !networkProfile.isMonitoring()) {
      return false;
    }
    if (vpnProfile && !vpnProfile.isMonitoring()) {
      return false;
    }
    return true;
  }

  // @TODO check according to multi interface
  isConnFlowValid(data) {
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
    const origIP = data["id.orig_h"]
    const respIP = data["id.resp_h"]

    if (sysManager.isLocalIP(origIP)) {
      if (!this.isMonitoring(origIP)) {
        return false // set it to invalid if it is not monitoring
      }
    }

    if (sysManager.isLocalIP(respIP)) {
      if (!this.isMonitoring(respIP)) {
        return false // set it to invalid if it is not monitoring
      }
    }

    return true
  }

  isUDPtrafficAccountable(obj) {
    const host = obj["id.orig_h"];
    const dst = obj["id.resp_h"];

    let deviceIP = null;

    if (sysManager.isLocalIP(host)) {
      deviceIP = host;
    } else {
      deviceIP = dst;
    }

    let device = null;

    if (iptool.isV4Format(deviceIP)) {
      device = hostManager.hostsdb[`host:ip4:${deviceIP}`];
    } else {
      device = hostManager.hostsdb[`host:ip6:${deviceIP}`];
    }

    let mac = device && device.o && device.o.mac;

    return !accounting.isBlockedDevice(mac);
  }

  validateConnData(obj) {
    const threshold = this.config.bro.threshold;
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

  async processConnData(data, long = false) {
    try {
      let obj = JSON.parse(data);
      if (obj == null) {
        log.debug("Conn:Drop", obj);
        return;
      }

      // drop layer 2.5
      if (obj.proto == "icmp") {
        return;
      }

      if (obj.service && obj.service == "dns") {
        return;
      }

      if (!this.isConnFlowValid(obj)) {
        return;
      }

      if (obj.proto === "udp" && !this.isUDPtrafficAccountable(obj)) {
        return; // ignore udp traffic if they are not valid
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

      const threshold = this.config.bro.threshold;

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

      // Long connection aggregation
      const uid = obj.uid
      if (long || this.activeLongConns[uid]) {
        const previous = this.activeLongConns[uid] || { ts: obj.ts, orig_bytes:0, resp_bytes: 0, duration: 0}

        // already aggregated
        if (previous.duration > obj.duration) return;

        // this.activeLongConns[uid] will be cleaned after certain time of inactivity
        this.activeLongConns[uid] = _.pick(obj, ['ts', 'orig_bytes', 'resp_bytes', 'duration'])

        const connCount = Object.keys(this.activeLongConns)

        if (connCount > 100)
          log.warn('Active long conn:', connCount);
        else
          log.debug('Active long conn:', connCount);

        obj.ts = Math.round((previous.ts + previous.duration) * 100) / 100
        obj.orig_bytes -= previous.orig_bytes
        obj.resp_bytes -= previous.resp_bytes
        obj.duration = Math.round((obj.duration - previous.duration) * 100) / 100
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
        if (obj.conn_state == "REJ" || obj.conn_state == "S2" || obj.conn_state == "S3" ||
          obj.conn_state == "RSTOS0" || obj.conn_state == "RSTRH" ||
          obj.conn_state == "SH" || obj.conn_state == "SHR" ||
          obj.conn_state == "S0") {
          log.debug("Conn:Drop:State:P1", obj.conn_state, JSON.stringify(obj));
          flag = 's';
          // return directly for the traffic flagged as 's'
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

      log.debug("ProcessingConection:", obj.uid, host, dst);

      // ignore multicast IP
      try {
        if (sysManager.isMulticastIP4(dst) || sysManager.isDNS(dst) || sysManager.isDNS(host)) {
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

      // fd: in, this flow initiated from inside
      // fd: out, this flow initated from outside, it is more dangerous

      if (iptool.isPrivate(host) == true && iptool.isPrivate(dst) == true) {
        flowdir = 'lo';
        lhost = host;
        localMac = origMac;
        log.debug("Local Traffic, both sides are in private network, ignored", obj);
        return;
      } else if (sysManager.isLocalIP(host) == true && sysManager.isLocalIP(dst) == true) {
        flowdir = 'lo';
        lhost = host;
        localMac = origMac;
        //log.debug("Dropping both ip address", host,dst);
        log.debug("Local Traffic, both sides are in local network, ignored", obj);
        return;
      } else if (sysManager.isLocalIP(host) == true && sysManager.isLocalIP(dst) == false) {
        flowdir = "in";
        lhost = host;
        localMac = origMac;
      } else if (sysManager.isLocalIP(host) == false && sysManager.isLocalIP(dst) == true) {
        flowdir = "out";
        lhost = dst;
        localMac = respMac;
      } else {
        log.debug("Conn:Error:Drop", data, host, dst, sysManager.isLocalIP(host), sysManager.isLocalIP(dst));
        return;
      }

      if (localMac && localMac.toUpperCase() === "FF:FF:FF:FF:FF:FF")
        return;

      const intfInfo = iptool.isV4Format(lhost) ? sysManager.getInterfaceViaIP4(lhost) : sysManager.getInterfaceViaIP6(lhost);
      if (intfInfo && intfInfo.uuid) {
        intfId = intfInfo.uuid;
      } else {
        log.error(`Conn: Unable to find nif uuid, ${intfId}`);
        intfId = '';
      }

      if (localMac && sysManager.isMyMac(localMac)) {
        // double confirm local mac is correct since bro may record Firewalla's MAC as local mac if packets are not fully captured due to ARP spoof leak
        if (!sysManager.isMyIP(lhost) && !(sysManager.isMyIP6(lhost))) {
          log.info("Discard incorrect local MAC address from bro log: ", localMac, lhost);
          localMac = null; // discard local mac from bro log since it is not correct
        }
      }
      if (!localMac && intfInfo && intfInfo.name !== "tun_fwvpn" && !(intfInfo.name && intfInfo.name.startsWith("wg"))) { // no need to query MAC for IP from VPN interface, otherwise it will spawn many 'cat' processes in Layer2.js
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
            return;
          });
        }
      }

      let localType = TYPE_MAC;
      let realLocal = null;
      let vpnProfile = null;
      if (!localMac && intfInfo && intfInfo.name === "tun_fwvpn") {
        vpnProfile = lhost && VPNProfileManager.getProfileCNByVirtualAddr(lhost);
        if (vpnProfile) {
          localMac = `${Constants.NS_VPN_PROFILE}:${vpnProfile}`;
          realLocal = VPNProfileManager.getRealAddrByVirtualAddr(lhost);
          localType = TYPE_VPN;
        }
      }

      if (!localMac || localMac.constructor.name !== "String") {
        localMac = null;
      }

      let tags = [];
      if (localMac && localType === TYPE_MAC) {
        localMac = localMac.toUpperCase();
        const hostInfo = hostManager.getHostFastByMAC(localMac);
        tags = hostInfo ? await hostInfo.getTags() : [];
      }

      if (intfId !== '') {
        const networkProfile = NetworkProfileManager.getNetworkProfile(intfId);
        if (networkProfile)
          tags = _.concat(tags, networkProfile.getTags());
      }
      tags = _.uniq(tags);

      if (Number(obj.orig_bytes) > threshold.logLargeBytesOrig) {
        log.error("Conn:Debug:Orig_bytes:", obj.orig_bytes, obj);
      }
      if (Number(obj.resp_bytes) > threshold.logLargeBytesResp) {
        log.error("Conn:Debug:Resp_bytes:", obj.resp_bytes, obj);
      }

      // Warning for long running tcp flows, the conn structure logs the ts as the
      // first packet.  when this happens, if the flow started a while back, it
      // will get summarize here
      //if (host == "192.168.2.164" || dst == "192.168.2.164") {
      //    log.error("Conn:192.168.2.164:",JSON.stringify(obj),null);
      // }

      // flowstash is the aggradation of flows within FLOWSTASH_EXPIRES seconds
      let now = Date.now() / 1000; // keep it as float, reduce the same score flows
      let flowspecKey = `${host}:${dst}:${intfId}:${obj['id.resp_p'] || ""}:${flowdir}`;
      let flowspec = this.flowstash[flowspecKey];
      let flowDescriptor = [
        Math.ceil(obj.ts),
        Math.ceil(obj.ts + obj.duration),
        Number(obj.orig_bytes),
        Number(obj.resp_bytes)
      ];

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
        mac: localMac, // mac address of local device
        intf: intfId, // intf id
        tags: tags,
        du: obj.duration,
        pf: {}, //port flow
        af: {}, //application flows
        pr: obj.proto,
        f: flag,
        flows: [flowDescriptor], // TODO: deprecate this to save memory
        uids: [obj.uid],
        ltype: localType
      };

      if (vpnProfile)
        tmpspec.vpf = vpnProfile;
      if (realLocal)
        tmpspec.rl = realLocal;

      if (obj['id.orig_p']) tmpspec.sp = [obj['id.orig_p']];
      if (obj['id.resp_p']) tmpspec.dp = obj['id.resp_p'];


      if (flowspec == null) {
        flowspec = tmpspec
        this.flowstash[flowspecKey] = flowspec;
        log.debug("Conn:FlowSpec:Create:", flowspec);
        this.indicateNewFlowSpec(flowspec);
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
        // flowspec.du = flowspec.ets - flowspec.ts;
        // For now, we use total time of network transfer, since the rate calculation is based on this logic.
        // Bear in mind that this duration may be different from (ets - ts) in most cases since there may be gap and overlaps between different flows.
        flowspec.du = Math.round((flowspec.du + obj.duration) * 100) / 100;
        flowspec.flows.push(flowDescriptor);
        if (flag) {
          flowspec.f = flag;
        }
        flowspec.uids.includes(obj.uid) || flowspec.uids.push(obj.uid)

        if (obj['id.orig_p'] && !flowspec.sp.includes(obj['id.orig_p'])) {
          flowspec.sp.push(obj['id.orig_p']);
        }
      }

      const afobj = this.lookupAppMap(obj.uid);
      if (afobj) {
        tmpspec.af[afobj.host] = afobj;
        if (!flowspec.af[afobj.host]) {
          flowspec.af[afobj.host] = afobj;
        }
        delete afobj.host;
      }

      // TODO: obsolete flow.pf and the following aggregation as flowstash now use port as part of its key
      if (obj['id.orig_p'] && obj['id.resp_p']) {

        let portflowkey = obj.proto + "." + obj['id.resp_p'];
        let port_flow = flowspec.pf[portflowkey];
        if (port_flow == null) {
          port_flow = {
            sp: [obj['id.orig_p']],
            ob: Number(obj.orig_bytes),
            rb: Number(obj.resp_bytes),
            ct: 1
          };
          flowspec.pf[portflowkey] = port_flow;
        } else {
          port_flow.sp.push(obj['id.orig_p']);
          port_flow.ob += Number(obj.orig_bytes);
          port_flow.rb += Number(obj.resp_bytes);
          port_flow.ct += 1;
        }
        //log.error("Conn:FlowSpec:FlowKey", portflowkey,port_flow,tmpspec);
      }

      // Single flow is written to redis first to prevent data loss
      // will be aggregated on flow stash expiration and removed in most cases
      if (tmpspec) {
        if (tmpspec.lh === tmpspec.sh && localMac && localType === TYPE_MAC) {
          // record device as active if and only if device originates the connection
          let macIPEntry = this.activeMac[localMac];
          if (!macIPEntry)
            macIPEntry = { ipv6Addr: [] };
          if (iptool.isV4Format(tmpspec.lh)) {
            macIPEntry.ipv4Addr = tmpspec.lh;
          } else {
            if (iptool.isV6Format(tmpspec.lh)) {
              macIPEntry.ipv6Addr.push(tmpspec.lh);
            }
          }
          this.activeMac[localMac] = macIPEntry;
        }

        const traffic = [ tmpspec.ob, tmpspec.rb ]
        if (tmpspec.fd == 'in') traffic.reverse()

        // use now instead of the start time of this flow
        this.recordTraffic(new Date() / 1000, ...traffic, tmpspec.ct, localMac);
        if (intfId) {
          this.recordTraffic(new Date() / 1000, ...traffic, tmpspec.ct, 'intf:' + intfId, true);
        }
        for (const tag of tags) {
          this.recordTraffic(new Date() / 1000, ...traffic, tmpspec.ct, 'tag:' + tag, true);
        }

        if (localMac) {
          let key = "flow:conn:" + tmpspec.fd + ":" + localMac;
          let strdata = JSON.stringify(tmpspec);

          //let redisObj = [key, tmpspec.ts, strdata];
          // beware that 'now' is used as score in flow:conn:* zset, since now is always monotonically increasing
          let redisObj = [key, now, strdata];
          log.debug("Conn:Save:Temp", redisObj);

          if (tmpspec.fd == 'out') {
            this.recordOutPort(tmpspec);
          }

          await rclient.zaddAsync(redisObj).catch(
            err => log.error("Failed to save tmpspec: ", tmpspec, err)
          )

          const remoteIPAddress = (tmpspec.lh === tmpspec.sh ? tmpspec.dh : tmpspec.sh);

          setTimeout(() => {
            sem.emitEvent({
              type: 'DestIPFound',
              ip: remoteIPAddress,
              fd: tmpspec.fd,
              ob: tmpspec.ob,
              rb: tmpspec.rb,
              suppressEventLogging: true,
              mac: localMac
            });
          }, 1 * 1000); // make it a little slower so that dns record will be handled first

        }
      }

      // TODO: Need to write code take care to ensure orig host is us ...
      let hostsChanged = {}; // record and update host lastActive

      // Every FLOWSTASH_EXPIRES seconds, save aggregated flowstash into redis and empties flowstash
      if (now > this.flowstashExpires) {
        let stashed = {};
        log.info("Processing Flow Stash");
        for (const specKey in this.flowstash) {
          const spec = this.flowstash[specKey];
          if (!spec.mac)
            continue;
          try {
            // try resolve host info for previous flows again here
            for (const uid of spec.uids) {
              const afobj = this.lookupAppMap(uid);
              if (afobj && !spec.af[afobj.host]) {
                spec.af[afobj.host] = afobj;
                delete afobj['host'];
              }
            }
          } catch (e) {
            log.error("Conn:Save:AFMAP:EXCEPTION", e);
          }

          const key = "flow:conn:" + spec.fd + ":" + spec.mac;
          const strdata = JSON.stringify(spec);
          // _ts is the last time when this flowspec is updated
          const redisObj = [key, spec._ts, strdata];
          if (stashed[key]) {
            stashed[key].push(redisObj);
          } else {
            stashed[key] = [redisObj];
          }

          try {
            if (spec.ob > 0 && spec.rb > 0 && spec.ct > 1) {
              let hostChanged = hostsChanged[spec.lh];
              if (hostChanged == null) {
                hostsChanged[spec.lh] = Number(spec.ts);
              } else {
                if (hostChanged < spec.ts) {
                  hostsChanged[spec.lh] = spec.ts;
                }
              }
            }
          } catch (e) {
            log.error("Conn:Save:Host:EXCEPTION", e);
          }

        }

        let sstart = this.flowstashExpires - FLOWSTASH_EXPIRES;
        let send = this.flowstashExpires;

        setTimeout(async () => {
          log.info("Conn:Save:Summary", sstart, send, this.flowstashExpires);
          for (let key in stashed) {
            let stash = stashed[key];
            log.debug("Conn:Save:Summary:Wipe", key, "Resolved To:", stash.length);

            let transaction = [];
            transaction.push(['zremrangebyscore', key, sstart, send]);
            stash.forEach(robj => transaction.push(['zadd', robj]));
            if (this.config.bro.conn.expires) {
              transaction.push(['expireat', key, parseInt(new Date / 1000) + this.config.bro.conn.expires])
            }

            try {
              await rclient.multi(transaction).execAsync();
              log.debug("Conn:Save:Removed", key);
            } catch (err) {
              log.error("Conn:Save:Error", err);
            }
          }
        }, FLOWSTASH_EXPIRES * 1000);

        this.flowstashExpires = now + FLOWSTASH_EXPIRES;
        this.flowstash = {};

        // record lastActive
        try {
          for (let i in hostsChanged) {
            dnsManager.resolveLocalHost(i, (err, data) => {
              if (data != null && data.lastActiveTimestamp != null) {
                if (data.lastActiveTimestamp < hostsChanged[i]) {
                  /*
                  log.debug("Conn:Flow:Resolve:Updated", i, hostsChanged[i]);
                  rclient.hmset("host:mac:" + data.mac, {
                      'lastActiveTimestamp': Number(hostsChanged[i])
                  });
                  */
                }
              } else {
                log.info("Conn:Flow:Resolve:Host Can not find ", i);
              }
            });
          }
        } catch (e) {
          log.error("Conn:Flow:Resolve:EXCEPTION", e);
        }

        // TODO add code here to delete from the ranked set ... ranked sets can not use key expire ....
      }



      //if (obj.note == null) {
      //    log.error("Http:Drop",obj);
      //    return;
      // }
    } catch (e) {
      log.error("Conn:Error Unable to save", e, data, new Error().stack);
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
      let host = obj["id.orig_h"];
      let dst = obj["id.resp_h"];
      if (firewalla.isReservedBlockingIP(dst))
        return;
      if (obj['server_name']) {
        obj['server_name'] = obj['server_name'].toLocaleLowerCase();
      }
      let dsthost = obj['server_name'];
      let subject = obj['subject'];
      let key = "host:ext.x509:" + dst;
      let cert_chain_fuids = obj['cert_chain_fuids'];
      let cert_id = null;
      let flowdir = "in";
      if (cert_chain_fuids != null && cert_chain_fuids.length > 0) {
        cert_id = cert_chain_fuids[0];
        log.debug("SSL:CERT_ID ", cert_id, subject, dst);
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

        rclient.del(key, (err) => { // delete before hmset in case number of keys is not same in old and new data
          rclient.hmset(key, xobj, (err, value) => {
            if (err == null) {
              if (this.config.bro.ssl.expires) {
                rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.ssl.expires);
              }
            } else {
              log.error("host:ext:x509:save:Error", key, subject);
            }
          });
        });
      } else if (cert_id != null) {
        log.debug("SSL:CERT_ID flow.ssl creating cert", cert_id);
        rclient.hgetall("flow:x509:" + cert_id, (err, data) => {
          if (err) {
            log.error("SSL:CERT_ID flow.x509:Error" + cert_id);
          } else {
            log.debug("SSL:CERT_ID found ", data);
            if (data != null && data["certificate.subject"]) {
              let xobj = {
                'subject': data['certificate.subject']
              };
              if (data.server_name) {
                xobj.server_name = data.server_name;
              }

              this.cleanUpSanDNS(xobj);

              rclient.del(key, (err) => { // delete before hmset in case number of keys is not same in old and new data
                rclient.hmset(key, xobj, (err, value) => {
                  if (err == null) {
                    if (this.config.bro.ssl.expires) {
                      rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.ssl.expires);
                    }
                    log.debug("SSL:CERT_ID Saved", key, xobj);
                  } else {
                    log.error("SSL:CERT_ID host:ext:x509:save:Error", key, subject);
                  }
                });
              });
            } else {
              log.debug("SSL:CERT_ID flow.x509:notfound" + cert_id);
            }
          }
        });

      }
      // Cache
      let appCacheObj = {
        uid: obj.uid,
        host: obj.server_name,
        ssl: obj.established
      };

      this.addAppMap(appCacheObj.uid, appCacheObj);
      /* this piece of code uses http to map dns */
      if (flowdir === "in" && obj.server_name) {
        await dnsTool.addReverseDns(obj.server_name, [dst]);
        await dnsTool.addDns(dst, obj.server_name, this.config.bro.dns.expires);
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

      let key = "flow:x509:" + obj['id'];
      log.debug("X509:Save", key, obj);

      this.cleanUpSanDNS(obj);

      rclient.hmset(key, obj, (err, value) => {
        if (err == null) {
          if (this.config.bro.x509.expires) {
            rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.x509.expires);
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

      const intfInfo = sysManager.getInterfaceViaIP4(ip);
      if (!intfInfo || !intfInfo.uuid) {
        log.warn(`KnownHosts: Unable to find nif uuid, ${ip}`);
        return;
      }

      log.info("Found a known host from host:", ip, intfInfo.name);

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
      if (this.config.bro.notice.ignore[obj.note] == null) {
        let strdata = JSON.stringify(obj);
        let key = "notice:" + obj.src;
        let redisObj = [key, obj.ts, strdata];
        log.debug("Notice:Save", redisObj);
        await rclient.zadd(redisObj);
        if (this.config.bro.notice.expires) {
          await rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.notice.expires);
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

  on(something, callback) {
    this.callbacks[something] = callback;
  }

  recordTraffic(ts, inBytes, outBytes, conn, mac, ignoreGlobal = false) {
    if (this.enableRecording) {


      const normalizedTS = Math.floor(Math.floor(Number(ts)) / 10) // only record every 10 seconds

      // lastNTS starts with null and assigned with normalizedTS every 10s
      if (this.lastNTS != normalizedTS) {
        const toRecord = this.timeSeriesCache

        this.lastNTS = normalizedTS
        this.fullLastNTS = Math.floor(ts)
        this.timeSeriesCache = { global: { upload: 0, download: 0, conn: 0 } }

        for (const key in toRecord) {
          const subKey = key == 'global' ? '' : ':' + key
          log.debug("Store timeseries", this.fullLastNTS, key, toRecord[key].download, toRecord[key].upload, toRecord[key].conn)
          timeSeries
            .recordHit('download' + subKey, this.fullLastNTS, toRecord[key].download)
            .recordHit('upload' + subKey, this.fullLastNTS, toRecord[key].upload)
            .recordHit('conn' + subKey, this.fullLastNTS, toRecord[key].conn)
        }
        timeSeries.exec()
      }

      // append current status
      if (!ignoreGlobal) {
        // // for traffic account
        // (async () => {
        //   await rclient.hincrbyAsync("stats:global", "download", Number(inBytes));
        //   await rclient.hincrbyAsync("stats:global", "upload", Number(outBytes));
        //   await rclient.hincrbyAsync("stats:global", "upload", Number(outBytes));
        // })()

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

  recordOutPort(tmpspec) {
    log.debug("recordOutPort: ", tmpspec);
    const key = tmpspec.mac + ":" + tmpspec.dp;
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
