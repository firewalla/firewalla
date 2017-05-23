/*    Copyright 2016 Rottiesoft LLC 
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

let log = require('./logger.js')(__filename);

var Tail = require('always-tail');
var redis = require("redis");
var rclient = redis.createClient();
var iptool = require("ip");
var useragent = require('useragent');

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

var DNSManager = require('./DNSManager.js');
var dnsManager = new DNSManager();

var AlarmManager = require('./AlarmManager.js');
var alarmManager = new AlarmManager('info');

let Alarm = require('../alarm/Alarm.js');
let AM2 = require('../alarm/AlarmManager2.js');
let am2 = new AM2();

var linux = require('../util/linux.js');

rclient.on("error", function (err) {
    log.info("Redis(alarm) Error " + err);
});

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

function ValidateIPaddress(ipaddress)   
{  
   if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress))  
      {  
        return (true)  
      }  
    return (false)  
}  

module.exports = class {
    initWatchers() {
        log.info("Initializing watchers", this.config.bro);
        if (this.intelLog == null) {
            this.intelLog = new Tail(this.config.bro.intel.path, '\n');
            if (this.intelLog != null) {
                log.info("Initializing watchers: intelog initialized:", this.config.bro.intel.path);
                this.intelLog.on('line', (data) => {
                    log.debug("Detect:Intel ", data);
                    this.processIntelData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.noticeLog == null) {
            this.noticeLog = new Tail(this.config.bro.notice.path, '\n');
            if (this.noticeLog != null) {
                log.info("Initializing watchers: noticeLog initialized", this.config.bro.notice.path);
                this.noticeLog.on('line', (data) => {
                    log.debug("Detect:Notice", data);
                    this.processNoticeData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.dnsLog == null) {
            this.dnsLog = new Tail(this.config.bro.dns.path, '\n');
            if (this.dnsLog != null) {
                log.info("Initializing watchers: dnslog initialized", this.config.bro.dns.path);
                this.dnsLog.on('line', (data) => {
                    this.processDnsData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.softwareLog == null) {
            this.softwareLog = new Tail(this.config.bro.software.path, '\n');
            if (this.softwareLog != null) {
                log.info("Initializing watchers: software initialized", this.config.bro.software.path);
                this.softwareLog.on('line', (data) => {
                    log.debug("Detect:Software", data);
                    this.processSoftwareData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.httpLog == null) {
            this.httpLog = new Tail(this.config.bro.http.path, '\n');
            if (this.httpLog != null) {
                log.info("Initializing watchers: http initialized", this.config.bro.http.path);
                this.httpLog.on('line', (data) => {
                    log.debug("Detect:Http", data);
                    this.processHttpData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.sslLog == null) {
            this.sslLog = new Tail(this.config.bro.ssl.path, '\n');
            if (this.sslLog != null) {
                log.info("Initializing watchers: sslinitialized", this.config.bro.ssl.path);
                this.sslLog.on('line', (data) => {
                    log.debug("Detect:SSL", data);
                    this.processSslData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.connLog == null) {
            this.connLog = new Tail(this.config.bro.conn.path, '\n');
            if (this.connLog != null) {
                log.info("Initializing watchers: connInitialized", this.config.bro.conn.path);
                this.connLog.on('line', (data) => {
                    this.processConnData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }
        if (this.connLogdev == null) {
            this.connLogdev = new Tail(this.config.bro.conn.pathdev, '\n');
            if (this.connLogdev != null) {
                log.info("Initializing watchers: connInitialized", this.config.bro.conn.pathdev);
                this.connLogdev.on('line', (data) => {
                    this.processConnData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.x509Log == null) {
            this.x509Log = new Tail(this.config.bro.x509.path, '\n');
            if (this.x509Log != null) {
                log.info("Initializing watchers: X509 Initialized", this.config.bro.x509.path);
                this.x509Log.on('line', (data) => {
                    this.processX509Data(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }

        if (this.knownHostsLog == null) {
            this.knownHostsLog = new Tail(this.config.bro.knownHosts.path, '\n');
            if (this.knownHostsLog != null) {
                log.info("Initializing watchers: knownHosts Initialized", this.config.bro.knownHosts.path);
                this.knownHostsLog.on('line', (data) => {
                    this.processknownHostsData(data);
                });
            } else {
                setTimeout(this.initWatchers, 5000);
            }
        }


    }

    constructor(name, config, loglevel) {
        if (instances[name] != null) {
            return instances[name];
        } else {
            this.config = config;
            log = require("./logger.js")("BroDetect", loglevel);
            this.appmap = {};
            this.apparray = [];
            this.connmap = {};
            this.connarray = [];
         
            this.initWatchers();
            instances[name] = this;
            let c = require('./MessageBus.js');
            this.publisher = new c(loglevel);
            this.flowstash = {};
            this.flowstashExpires = Date.now() / 1000 + this.config.bro.conn.flowstashExpires;
            this.flowstashStart = Date.now() / 1000 + this.config.bro.conn.flowstashExpires;
        }
    }

    start() {
        if (this.intelLog) {
            log.info("Start watching intel log");
            this.intelLog.watch();
        }
        if (this.noticeLog) {
            log.info("Start watching notice log");
            this.noticeLog.watch();
        }
    }

    addConnMap(key,value) {
        if (this.connmap[key]!=null) {
             return;
        } 
        log.info("CONN DEBUG",this.connarray.length,key,value,"length:");
        this.connarray.push(value);
        this.connmap[key] = value;
        let mapsize = 9000;
        if (this.connarray.length>mapsize) {
            let removed = this.connarray.splice(0,this.connarray.length-mapsize);
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
            if (index>-1) {
                this.connarray.splice(index,1);
            }
        }
        return obj;
    }

    addAppMap(key,value) {
        if (ValidateIPaddress(value.host)) {
             return;
        }

        if (this.appmap[key]!=null) {
             return;
        } 
        
        log.info("DEBUG",this.apparray.length,key,value,"length:", this.apparray.length);
        this.apparray.push(value);
        this.appmap[key] = value;
        let mapsize = 9000;
        if (this.apparray.length>mapsize) {
            let removed = this.apparray.splice(0,this.apparray.length-mapsize);
            for (let i in removed) {
                delete this.appmap[removed[i]['uid']];
            }
        }
    }

    lookupAppMap(key) {
        let obj = this.appmap[key];
        if (obj) {
            delete obj['uid'];
            delete this.appmap[key];
            let index = this.apparray.indexOf(obj);
            if (index>-1) {
                this.apparray.splice(index,1);
            }
        }
        return obj;
    }


    /*
    {"ts":1464244116.539545,"uid":"CwMpfX2Ya0NkxBCqbe","id.orig_h":"192.168.2.221","id.orig_p":58937,"id.resp_h":"199.27.79.143","id.resp_p":443,"fuid":"FmjEXV3czWtY9ykTG8","file_mime_type":"app
    lication/pkix-cert","file_desc":"199.27.79.143:443/tcp","seen.indicator":"forms.aweber.com","seen.indicator_type":"Intel::DOMAIN","seen.where":"X509::IN_CERT","seen.node":"bro","sources":["f
    rom http://hosts-file.net/psh.txt via intel.criticalstack.com"]}
    */

    processIntelData(data) {
        try {
            let obj = JSON.parse(data);
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
            log.error("Intel:Error Unable to save", e);
        }
    }

    //{"ts":1464066236.121734,"uid":"CnCRV73J3F0nhWtBPb","id.orig_h":"192.168.2.221","id.orig_p":5353,"id.resp_h":"224.0.0.251","id.resp_p":5353,"proto":"udp","trans_id":0,"query":"jianyu-chens-iphone-6.local","qclass":32769,"qclass_name":"qclass-32769","qtype":255,"qtype_name":"*","rcode":0,"rcode_name":"NOERROR","AA":true,"TC":false,"RD":false,"RA":false,"Z":0,"answers":["jianyu-chens-iphone-6.local","jianyu-chens-iphone-6.local","jianyu-chens-iphone-6.local","jianyu-chens-iphone-6.local"],"TTLs":[120.0,120.0,120.0,120.0],"rejected":false}
//{"ts":1482189510.68758,"uid":"Cl7FVE1EnC0fBhL8l7","id.orig_h":"2601:646:9100:74e0:e43e:adc7:6d48:76da","id.orig_p":53559,"id.resp_h":"2001:558:feed::1","id.resp_p":53,"proto":"udp","trans_id":12231,"query":"log-rts01-iad01.devices.nest.com","rcode":0,"rcode_name":"NOERROR","AA":false,"TC":false,"RD":false,"RA":true,"Z":0,"answers":["devices-rts01-production-331095621.us-east-1.elb.amazonaws.com","107.22.178.96","50.16.214.117","184.73.190.206","23.21.51.61"],"TTLs":[2.0,30.0,30.0,30.0,30.0],"rejected":false}

    processDnsData(data) {
        try {
            let obj = JSON.parse(data);
            if (obj == null || obj["id.resp_p"] != 53) {
                return;
            }
            if (obj["id.resp_p"] == 53 && obj["id.orig_h"] != null && obj["answers"] && obj["answers"].length > 0) {
                // NOTE write up a look up flow here 
                for (let i in obj['answers']) {
                    let key = "dns:ip:" + obj['answers'][i];
                    let value = {
                        'host': obj['query'],
                        'lastActive': Math.ceil(Date.now() / 1000),
                        'count': 1
                    }
                    rclient.hgetall(key,(err,entry)=>{ 
                        if (entry) {
                            if (entry.host != value.host) {
                                log.info("Dns:Remap",entry.host,value.host);
                                rclient.hdel(key,"_intel");
                            }
                            if (entry.count) {
                                value.count = Number(entry.count)+1;
                            }
                        }
                        rclient.hmset(key, value, (err, value) => {
                             //   rclient.hincrby(key, "count", 1, (err, value) => {
                             if (err == null) {
                                 if (this.config.bro.dns.expires) {
                                       rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.dns.expires);
                                 }
                             } else {
                                 log.error("Dns:Error", "unable to update count");
                             }
                              //  });
                        });
                    });
                }
            } else if (obj['id.orig_p'] == 5353 && obj['id.resp_p'] == 5353 && obj['answers'].length > 0) {
                let hostname = obj['answers'][0];
                let ip = obj['id.orig_p'];
                let key = "host:ip4:" + ip;
                log.debug("Dns:FindHostWithIP", key, ip, hostname);

                dnsManager.resolveLocalHost(ip, (err, data) => {
                    if (err == null && data.mac != null && data != null && data.name == null && data.bname == null) {
                        let changeset = {
                            name: hostname,
                            bname: hostname
                        };
                        //changeset['lastActiveTimestamp'] = Math.ceil(Date.now() / 1000);
                        log.debug("Dns:Redis:Merge", key, changeset, {});
                        rclient.hmset("host:mac:" + data.mac, changeset, (err, result) => {
                            if (err) {
                                log.error("Discovery:Nmap:Update:Error", err);
                            }
                        });
                    }
                });
            }
        } catch (e) {
            log.error("Detect:Dns:Error", e, data);
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
            log.error("Detect:Software:Error", e, data);
        }
    }

 
    // We now seen a new flow coming ... which might have a new ip getting discovered, lets take care of this
    indicateNewFlowSpec(flowspec) {
        let ip = flowspec.lh;
        if (this.pingedIp==null) {
            this.pingedIp = {};
            setTimeout(()=>{
              this.pingedIp = null;
            },1000*60*60*24);
        }
        if (sysManager.ipLearned(ip)==false && this.pingedIp[ip]==null) {
           //log.info("Conn:Learned:Ip",ip,flowspec);
           if (!iptool.isV4Format(ip)) {
              log.info("Conn:Learned:Ip","ping ",ip,flowspec);
              linux.ping6(sysManager.monitoringInterface().name,ip)    
              this.pingedIp[ip]=true;
           }
        }
    }

    /*
     * {"ts":1464303791.790091,"uid":"CosE7p2gSFbxvdRig2","id.orig_h":"fe80::6a5b:35ff:fec9:b9cb","id.orig_p":143,"id.resp_h":"ff02::16","id.resp_p":0,"proto":"icmp","conn_state":"OTH","local_orig":false,"local_resp":false,"missed_bytes":0,"orig_pkts":1,"orig_ip_bytes":196,"resp_pkts":0,"resp_ip_bytes":0,"tunnel_parents":[]}

    2016-05-27T06:00:34.110Z - debug: Conn:Save 0=flow:conn:in:192.168.2.232, 1=1464328691.497809, 2={"ts":1464328691.497809,"uid":"C3Lb6y27y6fEbngara","id.orig_h":"192.168.2.232","id.orig_p":58137,"id.resp_h":"216.58.194.194","id.resp_p":443,"proto":"tcp","service":"ssl","duration":136.54717,"orig_bytes":1071,"resp_bytes":5315,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":48,"orig_ip_bytes":4710,"resp_pkts":34,"resp_ip_bytes":12414,"tunnel_parents":[]}

    */

    // Only log ipv4 packets for now
    processConnData(data) {
        try {
            let obj = JSON.parse(data);
            if (obj == null) {
                log.error("Conn:Drop", obj);
                return;
            }
            
            // drop layer 2.5
            if (obj.proto=="icmp") {
                return;
            }

            if (obj.service && obj.service == "dns") {
                return;
            }

            // drop layer 3 
            if (obj.orig_ip_bytes==0 && obj.resp_ip_bytes==0) {
                log.error("Conn:Drop:ZeroLength",obj.conn_state,obj);
                return;
            }

            if (obj.orig_bytes == null || obj.resp_bytes == null) {
                log.error("Conn:Drop:NullBytes",obj);
                return;
            }

            // drop layer 4
            if (obj.orig_bytes == 0 && obj.resp_bytes == 0) {
                log.error("Conn:Drop:ZeroLength2",obj.conn_state,obj);
                return;
            }

            if (obj.missed_bytes>10000000) { // based on 2 seconds of full blast at 50Mbit, max possible we can miss bytes
                log.error("Conn:Drop:MissedBytes:TooLarge",obj.conn_state,obj);
                return;
            }

            if (obj.proto && obj.proto=="tcp") {
                if (obj.resp_bytes>1000000 && obj.orig_bytes==0 && obj.conn_state=="SF") {
                    log.error("Conn:Adjusted:TCPZero",obj.conn_state,obj);
                    return;
                }
                else if (obj.orig_bytes>1000000 && obj.resp_bytes ==0 && obj.conn_state=="SF") {
                    log.error("Conn:Adjusted:TCPZero",obj.conn_state,obj);
                    return;
                }
            }
            if (obj.resp_bytes >100000000) {
                if (obj.duration<1) {
                    log.error("Conn:Burst:Drop",obj);
                    return;
                }
                let rate = obj.resp_bytes/obj.duration;
                if (rate>20000000) {
                    log.error("Conn:Burst:Drop",rate,obj);
                    return;
                } 
                let packet = obj.resp_bytes/obj.resp_pkts;
                if (packet >10000000) {
                    log.error("Conn:Burst:Drop2",packet,obj);
                    return;
                }
            }
            if (obj.orig_bytes >100000000) {
                if (obj.duration<1) {
                    log.error("Conn:Burst:Drop:Orig",obj);
                    return;
                }
                let rate = obj.orig_bytes/obj.duration;
                if (rate>20000000) {
                    log.error("Conn:Burst:Drop:Orig",rate,obj);
                    return;
                }
                let packet = obj.orig_bytes/obj.orig_pkts;
                if (packet >10000000) {
                    log.error("Conn:Burst:Drop2:Orig",packet,obj);
                    return;
                }
            }

            if (obj.missed_bytes>0) {
                let adjusted = false;
                if (obj.orig_bytes - obj.missed_bytes > 0) {
                    obj.orig_bytes = obj.orig_bytes - obj.missed_bytes;
                    adjusted = true;
                }
                if (obj.resp_bytes - obj.missed_bytes > 0) {
                    obj.resp_bytes = obj.resp_bytes - obj.missed_bytes;
                    adjusted = true;
                }
                if (adjusted == false) {
                    log.error("Conn:Drop:MissedBytes",obj.conn_state,obj);
                    return;
                } else {
                    log.debug("Conn:Adjusted:MissedBytes",obj.conn_state,obj);
                }
            }

            let flag = null;
            if (obj.proto == "tcp" && (obj.orig_bytes == 0 || obj.resp_bytes == 0)) {
                if (obj.conn_state=="REJ" || obj.conn_state=="S2" || obj.conn_state=="S3" ||
                    obj.conn_state=="RSTOS0" || obj.conn_state=="RSTRH" ||
                    obj.conn_state == "SH" || obj.conn_state == "SHR" || obj.conn_state == "OTH" ||
                    obj.conn_state == "S0") {
                        log.error("Conn:Drop:State",obj.conn_state,obj);
                        flag = 's';
               //         return;
                }
            }


            let host = obj["id.orig_h"];
            let dst = obj["id.resp_h"];
            let flowdir = "in";
            let lhost = null;

            log.info("ProcessingConection:",obj.uid,host,dst);

            // ignore multicast IP
            // if (sysManager.isMulticastIP(dst) || sysManager.isDNS(dst) || sysManager.isDNS(host)) {
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
                log.error("Conn:Data:Error checking ulticast", e);
                return;
            }

            if (iptool.isPrivate(host) == true && iptool.isPrivate(dst) == true) {
                flowdir = 'local';
                lhost = host;
                return;
            } else if (sysManager.isLocalIP(host) == true && sysManager.isLocalIP(dst) == true) {
                flowdir = 'local';
                lhost = host;
                //log.debug("Dropping both ip address", host,dst);
                return;
            } else if (sysManager.isLocalIP(host) == true && sysManager.isLocalIP(dst) == false) {
                flowdir = "in";
                lhost = host;
            } else if (sysManager.isLocalIP(host) == false && sysManager.isLocalIP(dst) == true) {
                flowdir = "out";
                lhost = dst;
            } else {
                log.error("Conn:Error:Drop", data, host, dst, sysManager.isLocalIP(host), sysManager.isLocalIP(dst));
                return;
            }

            if (obj.orig_bytes == null) {
                obj.orig_bytes = 0;
            }
            if (obj.resp_bytes == null) {
                obj.resp_bytes = 0;
            }

            if (obj.duration == null) {
                obj.duration = Number(0);
            } else {
                obj.duration = Number(obj.duration);
            }

            if (obj.orig_bytes >100000000) {
                log.error("Conn:Debug:Orig_bytes:",obj.orig_bytes,obj);
            }
            if (obj.resp_bytes >100000000) {
                log.error("Conn:Debug:Resp_bytes:",obj.resp_bytes,obj);
            }
            if (Number(obj.orig_bytes) >100000000) {
                log.error("Conn:Debug:Orig_bytes:",obj.orig_bytes,obj);
            }
            if (Number(obj.resp_bytes) >100000000) {
                log.error("Conn:Debug:Resp_bytes:",obj.resp_bytes,obj);
            }

            // Warning for long running tcp flows, the conn structure logs the ts as the
            // first packet.  when this happens, if the flow started a while back, it 
            // will get summarize here

            let now = Math.ceil(Date.now() / 1000);
            let flowspecKey = host + ":" + dst + ":" + flowdir;
            let flowspec = this.flowstash[flowspecKey];
            if (flowspec == null) {
                flowspec = {
                    ts: obj.ts,
                   _ts: now,
                  __ts: obj.ts,  // this is the first time found 
                    sh: host, // source
                    dh: dst, // dstination
                    ob: Number(obj.orig_bytes), // transfer bytes
                    rb: Number(obj.resp_bytes),
                    ct: 1, // count
                    fd: flowdir, // flow direction
                    lh: lhost, // this is local ip address
                    du: obj.duration,
                    bl: this.config.bro.conn.flowstashExpires,
                    pf: {}, //port flow
                    af: {}, //application flows
                    pr: obj.proto,
                    f: flag,
                 flows: [[Math.ceil(obj.ts),Math.ceil(obj.ts+obj.duration),Number(obj.orig_bytes),Number(obj.resp_bytes)]],
                _afmap: {}
                }
                this.flowstash[flowspecKey] = flowspec;
                log.debug("Conn:FlowSpec:Create:", flowspec);
                this.indicateNewFlowSpec(flowspec);
            } else {
                flowspec.ob += Number(obj.orig_bytes);
                flowspec.rb += Number(obj.resp_bytes);
                flowspec.ct += 1;
                if (flowspec.ts < obj.ts) {
                    flowspec.ts = obj.ts;
                }
                flowspec._ts = now;
                flowspec.du += obj.duration;
                flowspec.flows.push([Math.ceil(obj.ts),Math.ceil(obj.ts+obj.duration),Number(obj.orig_bytes),Number(obj.resp_bytes)]);
            }

            let tmpspec = {
                ts: obj.ts,
                sh: host, // source
               _ts: now,
                dh: dst, // dstination
                ob: Number(obj.orig_bytes), // transfer bytes
                rb: Number(obj.resp_bytes),
                ct: 1, // count
                fd: flowdir, // flow direction
                lh: lhost, // this is local ip address
                du: obj.duration,
                bl: 0,
                pf: {},
                af: {},
                pr: obj.proto,
                f: flag,
             flows: [[Math.ceil(obj.ts),Math.ceil(obj.ts+obj.duration),Number(obj.orig_bytes),Number(obj.resp_bytes)]],
            };

            let afobj = this.lookupAppMap(obj.uid);
            if (afobj) {
                tmpspec.af[afobj.host] = afobj;
                let flow_afobj = flowspec.af[afobj.host];
                if (flow_afobj) {
                    flow_afobj.rqbl += afobj.rqbl;
                    flow_afobj.rsbl += afobj.rsbl;
                } else {
                    flowspec.af[afobj.host] = afobj;
                    delete afobj['host'];
                }
            } else {
                flowspec._afmap[obj.uid]=obj.uid;
                // redo some older lookup ...
                for (let i in flowspec._afmap) {
                    let afobj = this.lookupAppMap(i);
                    if (afobj) {
                        log.info("DEBUG AFOBJ DELAY RESOLVE",afobj);
                        let flow_afobj = flowspec.af[afobj.host];
                        if (flow_afobj) {
                            flow_afobj.rqbl += afobj.rqbl;
                            flow_afobj.rsbl += afobj.rsbl;
                        } else {
                            flowspec.af[afobj.host] = afobj;
                            delete afobj['host'];
                        }
                    }
                }
            }

          if (obj['id.orig_p'] != null && obj['id.resp_p'] != null) {
            tmpspec.sp = obj['id.orig_p'];
            tmpspec.dp = obj['id.resp_p'];
            
                let portflowkey = obj.proto+"."+obj['id.resp_p'];
                let port_flow = flowspec.pf[portflowkey];
                if (port_flow == null) {
                    port_flow = {
                        ob: Number(flowspec.ob),
                        rb: Number(flowspec.rb),
                        ct: 1
                    };
                    flowspec.pf[portflowkey] = port_flow;
                } else {
                    port_flow.ob += Number(obj.orig_bytes);
                    port_flow.rb += Number(obj.resp_bytes);
                    port_flow.ct += 1;
                }
                tmpspec.pf[portflowkey] = {
                    ob: Number(obj.orig_bytes),
                    rb: Number(obj.resp_bytes),
                    ct: 1
                };
                //log.error("Conn:FlowSpec:FlowKey", portflowkey,port_flow,tmpspec);
            }

            if (tmpspec) {
                let key = "flow:conn:" + tmpspec.fd + ":" + tmpspec.lh;
                let strdata = JSON.stringify(tmpspec);
                //let redisObj = [key, tmpspec.ts, strdata];
                let redisObj = [key, now, strdata];
                log.info("Conn:Save:Temp", redisObj);
                rclient.zadd(redisObj, (err, response) => {
                    if (err == null) {
                        if (this.config.bro.conn.expires) {
                            //rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.conn.flowstashExpires);
                        }
                    } else {}
                });
            }

            // TODO: Need to write code take care to ensure orig host is us ...
            let hostsChanged = {}; // record and update host lastActive

            if (now > this.flowstashExpires) {
                let stashed={};
                log.info("Processing Flow Stash");
                for (let i in this.flowstash) {
                    let spec = this.flowstash[i];
                    try {
                        if (Object.keys(spec._afmap).length>0) {
                            for (let i in spec._afmap) {
                                let afobj = this.lookupAppMap(i);
                                if (afobj) {
                                     let flow_afobj = spec.af[afobj.host];
                                     if (flow_afobj) {
                                         flow_afobj.rqbl += afobj.rqbl;
                                         flow_afobj.rsbl += afobj.rsbl;
                                     } else {
                                         spec.af[afobj.host] = afobj;
                                         delete afobj['host'];
                                     }
                                }
                            }
                        }
                    } catch(e) {
                        log.error("Conn:Save:AFMAP:EXCEPTION", e);
                    }
                    delete spec._afmap;
                    let key = "flow:conn:" + spec.fd + ":" + spec.lh;
                    let strdata = JSON.stringify(spec);
                    let ts = spec._ts;
                    if (spec.ts>this.flowstashExpires-this.config.bro.conn.flowstashExpires) {
                        ts = spec.ts;
                    }
                    let redisObj = [key, ts, strdata];
                    if (stashed[key]) {
                        stashed[key].push(redisObj);
                    } else {
                        stashed[key]=[redisObj];
                    }


                    try {
                        if (spec.ob>0 && spec.rb>0 && spec.ct>1) { 
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

                let sstart = this.flowstashExpires-this.config.bro.conn.flowstashExpires;
                let send = this.flowstashExpires;
                setTimeout(()=>{
                    log.info("Conn:Save:Summary", sstart,send,this.flowstashExpires);
                    for (let key in stashed) {
                        let stash = stashed[key];
                        log.info("Conn:Save:Summary:Wipe",key, "Resoved To: ", stash.length);
                        rclient.zremrangebyscore(key,sstart,send, (err, data) => {
                            log.info("Conn:Info:Removed",key,err,data);
                            for (let i in stash) {
                                rclient.zadd(stash[i], (err, response) => {
                                    if (err == null) {
                                        if (this.config.bro.conn.expires) {
                                            rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.conn.expires);
                                        }
                                    } else {
                                        log.error("Conn:Save:Error", err);
                                    }
                                });
                            }
                        });
                    }
                },this.config.bro.conn.flowstashExpires*1000);

                this.flowstashExpires = now + this.config.bro.conn.flowstashExpires;
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

    processHttpData(data) {
        try {
            let obj = JSON.parse(data);
            if (obj == null) {
                log.error("HTTP:Drop", obj);
                return;
            }

            let host = obj["id.orig_h"];
            let dst = obj["id.resp_h"];
            let flowdir = "in";

            /*
            if (!iptool.isV4Format(host)) {
                 return;                
            } 
            */

            if (sysManager.isLocalIP(host) && sysManager.isLocalIP(dst)) {
                let flowdir = 'local';
                return;
            } else if (sysManager.isLocalIP(host) && sysManager.isLocalIP(dst) == false) {
                let flowdir = "out";
            } else if (sysManager.isLocalIP(host) == false && sysManager.isLocalIP(dst)) {
                let flowdir = "in";
            } else {
                log.error("HTTP:Error:Drop", data);
                return;
            }


            // Cache
            let appCacheObj = {
                uid: obj.uid,
                host: obj.host,
                uri: obj.uri,
                rqbl: obj.request_body_len,
                rsbl: obj.response_body_len,
            };
       
            this.addAppMap(appCacheObj.uid, appCacheObj);

            // TODO: Need to write code take care to ensure orig host is us ...

            if (obj.user_agent != null) {
                let agent = useragent.parse(obj.user_agent);
                if (agent != null) {
                    if (agent.device.family != null) {
                        let okey = "host:user_agent:" + host;
                        let o = {
                            'family': agent.device.family,
                            'os': agent.os.toString(),
                            'ua': obj.user_agent
                        };
                        rclient.sadd(okey, JSON.stringify(o), (err, response) => {
                            rclient.expireat(okey, parseInt((+new Date) / 1000) + this.config.bro.userAgent.expires);
                            if (err != null) {
                                log.error("HTTP:Save:Error", err, o);
                            } else {
                                log.debug("HTTP:Save:Agent", host, o);
                            }
                        });
                        dnsManager.resolveLocalHost(host, (err, data) => {
                            if (data && data.mac) {
                                let mkey = "host:user_agent_m:" + data.mac;
                                rclient.sadd(mkey, JSON.stringify(o), (err, response) => {
                                    rclient.expireat(mkey, parseInt((+new Date) / 1000) + this.config.bro.userAgent.expires);
                                    if (err != null) {
                                        log.error("HTTP:Save:Error", err, o);
                                    } else {
                                        log.debug("HTTP:Save:Agent", host, o);
                                    }
                                });
                            }
                        });

                    }
                }
            }

            let key = "flow:http:" + flowdir + ":" + host;
            let strdata = JSON.stringify(obj);
            let redisObj = [key, obj.ts, strdata];
            log.debug("HTTP:Save", redisObj);

            rclient.zadd(redisObj, (err, response) => {
                if (err == null) {
                    if (this.config.bro.http.expires) {
                        rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.http.expires);
                    } else {
                        rclient.expireat(key, parseInt((+new Date) / 1000) + 60*30);
                    }
                } else {
                    log.error("HTTP:Save:Error", err);
                }
            });

        } catch (e) {
            log.error("HTTP:Error Unable to save", e, data);
        }

    }


    processSslData2(data) {
        try {
            let obj = JSON.parse(data);
            if (obj == null) {
                log.error("SSL:Drop", obj);
                return;
            }

            let host = obj["id.orig_h"];
            let dst = obj["id.resp_h"];
            let dsthost = obj['server_name'];
            let flowdir = "in";
            // Cache
            let appCacheObj = {
                uid: obj.uid,
                host: obj.server_name,
                ssl: true,
                rqbl: 0,
                rsbl: 0,
            };
       
            this.addAppMap(appCacheObj.uid, appCacheObj);

            // TODO: Need to write code take care to ensure orig host is us ...
            let key = "flow:ssl:" + flowdir + ":" + host;
            let strdata = JSON.stringify(obj);
            let redisObj = [key, obj.ts, strdata];
            log.debug("SSL:Save", redisObj);
            rclient.zadd(redisObj, (err, response) => {
                if (err == null) {
                    if (this.config.bro.ssl.expires) {
                        rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.ssl.expires);
                    }
                } else {
                    log.error("SSL:Save:Error", err);
                }
            });

        } catch (e) {
            log.error("SSL:Error Unable to save", e);
        }
    }


    processSslData(data) {
        try {
            let obj = JSON.parse(data);
            if (obj == null) {
                log.error("SSL:Drop", obj);
                return;
            }

            let host = obj["id.orig_h"];
            let dst = obj["id.resp_h"];
            let dsthost = obj['server_name'];
            let subject = obj['subject'];
            let key = "host:ext.x509:" + dst;
            let cert_chain_fuids = obj['cert_chain_fuids'];
            let cert_id = null;
            if (cert_chain_fuids != null && cert_chain_fuids.length > 0) {
                cert_id = cert_chain_fuids[0];
                log.debug("SSL:CERT_ID ", cert_id, subject, dst);
            }

            if (subject != null && dst != null) {
                let xobj = {
                    'subject': subject
                };
                if (dsthost != null) {
                    xobj['server_name'] = dsthost;
                }
                log.debug("SSL: host:ext:x509:Save", key, xobj);
                rclient.hmset(key, xobj, (err, value) => {
                    if (err == null) {
                        if (this.config.bro.ssl.expires) {
                            rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.ssl.expires);
                        }
                    } else {
                        log.error("host:ext:x509:save:Error", key, subject);
                    }
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
                        } else {
                            log.debug("SSL:CERT_ID flow.x509:notfound" + cert_id);
                        }
                    }
                });

            }

        } catch (e) {
            log.error("SSL:Error Unable to save", e);
        }
    }


    processX509Data(data) {
        try {
            let obj = JSON.parse(data);
            if (obj == null) {
                log.error("X509:Drop", data);
                return;
            }

            let key = "flow:x509:" + obj['id'];
            log.debug("X509:Save", key, obj);
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
            log.error("X509:Error Unable to save", e);
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
            this.publisher.publish("DiscoveryEvent", "Host:Detected", obj['host'], obj);

        } catch (e) {}
    }

    //{"ts":1465969866.72256,"note":"Scan::Port_Scan","msg":"192.168.2.190 scanned at least 15 unique ports of host 192.168.2.108 in 0m1s","sub":"local","src":
    //"192.168.2.190","dst":"192.168.2.108","peer_descr":"bro","actions":["Notice::ACTION_LOG"],"suppress_for":3600.0,"dropped":false}


    processNoticeData(data) {
        try {
            let obj = JSON.parse(data);
            if (obj.note == null) {
                log.error("Notice:Drop", obj);
                return;
            }
            if ((obj.src != null && obj.src == sysManager.myIp()) || (obj.dst != null && obj.dst == sysManager.myIp())) {
                log.error("Notice:Drop My IP", obj);
                return;
            }
            log.info("Notice:Processing",obj);
            if (this.config.bro.notice.ignore[obj.note] == null) {
                let strdata = JSON.stringify(obj);
                let key = "notice:" + obj.src;
                let redisObj = [key, obj.ts, strdata];
                log.debug("Notice:Save", redisObj);
                rclient.zadd(redisObj, (err, response) => {
                    if (err) {
                        log.error("Notice:Save:Error", err);
                    } else {
                        if (this.config.bro.notice.expires) {
                            rclient.expireat(key, parseInt((+new Date) / 1000) + this.config.bro.notice.expires);
                        }
                    }
                });
                let lh = null;
                if (sysManager.isLocalIP(obj.src)) {
                    lh = obj.src;
                } else if (sysManager.isLocalIP(obj.dst)) {
                    lh = obj.dst;
                } else {
                    lh = "0.0.0.0";
                }
        
                let actionobj = {
                     title: obj.msg,
                     actions: ["ignore"],
                     src: obj.src, 
                     dst: obj.dst,
                     note: obj.note,
                     target: lh,
                     msg: obj.msg,
                     obj: obj
                };

                dnsManager.resolvehost(obj.src,(err,__src)=>{
                    dnsManager.resolvehost(obj.dst,(err,__dst)=>{
                      actionobj.shname =dnsManager.name(__src);
                      actionobj.dhname =dnsManager.name(__dst);

                      let localIP = lh;
                      let message = obj.msg;
                      let noticeType = obj.note;
                      let timestamp = parseFloat(obj.ts);
                      
                      let alarm = new Alarm.BroNoticeAlarm(timestamp, localIP, noticeType, message, {
                        "p.device.ip": localIP,
                      });

                      am2.enrichDeviceInfo(alarm).then((alarm) => {
                        am2.checkAndSave(alarm, (err) => {
                          if(err) {
                            log.error("Failed to save alarm: " + err);
                          }
                        });
                      });
                      
                      alarmManager.alarm(lh, "notice", 'info', '0', {"msg":obj.msg}, actionobj, (err,obj,action)=> {
                        // if (obj != null) {
                        //          this.publisher.publish("DiscoveryEvent", "Notice:Detected", lh, obj);
                        // }
                      });
                    }); 
                }); 

            } else {
              log.info("Notice:Drop> Notice type " + obj.note + " is ignored");
            }
        } catch (e) {
            log.error("Notice:Error Unable to save", e,data);
        }
    }

    on(something, callback) {
        this.callbacks[something] = callback;
    }

}
