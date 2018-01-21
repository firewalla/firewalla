/*    Copyright 2016 Firewalla LLC
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

var iptool = require('ip');
var os = require('os');
var network = require('network');
var instances = {};

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

const exec = require('child-process-promise').exec

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);

var Spoofer = require('./Spoofer.js');
var spoofer = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');
var DNSManager = require('./DNSManager.js');
var dnsManager = new DNSManager('error');
var FlowManager = require('./FlowManager.js');
var flowManager = new FlowManager('debug');
var IntelManager = require('./IntelManager.js');
var intelManager = new IntelManager('debug');

let FRP = require('../extension/frp/frp.js')
let frp = new FRP();

var PolicyManager = require('./PolicyManager.js');
var policyManager = new PolicyManager('info');

let AlarmManager2 = require('../alarm/AlarmManager2.js');
let alarmManager2 = new AlarmManager2();

let PolicyManager2 = require('../alarm/PolicyManager2.js');
let policyManager2 = new PolicyManager2();

let ExceptionManager = require('../alarm/ExceptionManager.js');
let exceptionManager = new ExceptionManager();

let spooferManager = require('./SpooferManager.js')

let modeManager = require('./ModeManager.js');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let f = require('./Firewalla.js');

const license = require('../util/license.js')

var alarmManager = null;

var uuid = require('uuid');
var bone = require("../lib/Bone.js");

var utils = require('../lib/utils.js');

let fConfig = require('./config.js').getConfig();

const fc = require('./config.js')

rclient.on("error", function (err) {
    log.info("Redis(alarm) Error " + err);
});
sclient.on("error", function (err) {
    log.info("Redis(alarm) Error " + err);
});

var _async = require('async');

var MobileDetect = require('mobile-detect');

var flowUtil = require('../net2/FlowUtil.js');

let AppTool = require('./AppTool');
let appTool = new AppTool();

var linux = require('../util/linux.js');

/* alarms:
    alarmtype:  intel/newhost/scan/log
    severityscore: out of 100
    alarmseverity: major minor
*/


class Host {
    constructor(obj,mgr, callback) {
        this.callbacks = {};
        this.o = obj;
        this.mgr = mgr;
        if (this.o.ipv4) {
            this.o.ipv4Addr = this.o.ipv4;
        }

      this._mark = false;
      this.parse();

      let c = require('./MessageBus.js');
      this.subscriber = new c('debug');

        if(this.mgr.type === 'server') {
          this.spoofing = false;
          sclient.on("message", (channel, message) => {
            this.processNotifications(channel, message);
          });

          if (obj != null) {
            this.subscribe(this.o.ipv4Addr, "Notice:Detected");
            this.subscribe(this.o.ipv4Addr, "Intel:Detected");
            this.subscribe(this.o.ipv4Addr, "HostPolicy:Changed");
          }
          this.spoofing = false;

          /*
           if (this.o.ipv6Addr) {
           this.o.ipv6Addr = JSON.parse(this.o.ipv6Addr);
           }
           */
          this.predictHostNameUsingUserAgent();

          this.loadPolicy(callback);
        }
    }

    update(obj) {
        this.o = obj;
        if (this.o.ipv4) {
            this.o.ipv4Addr = this.o.ipv4;
        }

        if(this.mgr.type === 'server') {
          if (obj != null) {
            this.subscribe(this.o.ipv4Addr, "Notice:Detected");
            this.subscribe(this.o.ipv4Addr, "Intel:Detected");
            this.subscribe(this.o.ipv4Addr, "HostPolicy:Changed");
          }
          this.predictHostNameUsingUserAgent();
          this.loadPolicy(null);
        }

        this.parse();
    }

/* example of ipv6Host
1) "mac"
2) "B8:53:AC:5F:99:51"
3) "firstFoundTimestamp"
4) "1511599097.786"
5) "lastActiveTimestamp"
6) "1511846844.798"

*/

    keepalive() {
        for (let i in this.ipv6Addr) {
            log.debug("keep alive ", this.mac,this.ipv6Addr[i]);
            linux.ping6(null,this.ipv6Addr[i]);
        }
        setTimeout(()=>{
            this.cleanV6();
        },1000*10);
    }

    cleanV6() {
        return async(()=> {
            if (this.ipv6Addr == null) {
                return;
            }

            let ts = (new Date())/1000;
            let lastActive = 0;
            let _ipv6Hosts = {};
            this._ipv6Hosts = {};

            for (let i in this.ipv6Addr) {
                let ip6 = this.ipv6Addr[i];
                let ip6Host = await(rclient.hgetallAsync("host:ip6:"+ip6));
                log.debug("HostManager:CleanV6:looking up v6",ip6,ip6Host)
                if (ip6Host != null) {
                    _ipv6Hosts[ip6] = ip6Host;
                    if (ip6Host.lastActiveTimestamp > lastActive) {
                        lastActive = ip6Host.lastActiveTimestamp;
                    }
                }
            }

            this.ipv6Addr = [];
            for (let ip6 in _ipv6Hosts) {
                let ip6Host = _ipv6Hosts[ip6];
                if (ip6Host.lastActiveTimestamp < lastActive - 60*30 || ip6Host.lastActiveTimestamp < ts-60*40) {
                    log.info("Host:"+this.mac+","+ts+","+ip6Host.lastActiveTimestamp+","+lastActive+" Remove Old Address "+ip6,JSON.stringify(ip6Host));
                } else {
                    this._ipv6Hosts[ip6] = ip6Host;
                    this.ipv6Addr.push(ip6);
                }
            }

            if (this.o.lastActiveTimestamp < lastActive) {
                this.o.lastActiveTimestamp = lastActive;
            }

            //await(this.saveAsync());
            log.debug("HostManager:CleanV6:", this.o.mac, JSON.stringify(this.ipv6Addr));
        })();
    }

    predictHostNameUsingUserAgent() {
        if (this.hasBeenGivenName() == false) {
            rclient.smembers("host:user_agent_m:" + this.o.mac, (err, results) => {
                if (results != null && results.length > 0) {
                    let familydb = {};
                    let osdb = {};
                    let mobile = false;
                    let md_osdb = {};
                    let md_name = {};

                    for (let i in results) {
                        let r = JSON.parse(results[i]);
                        if (r.ua) {
                            let md = new MobileDetect(r.ua);
                            if (md == null) {
                                log.info("MD Null");
                                continue;
                            }
                            let name = null;
                            if (md.mobile()) {
                                mobile = true;
                                name = md.mobile();
                            }
                            let os = md.os();
                            if (os != null) {
                                if (md_osdb[os]) {
                                    md_osdb[os] += 1;
                                } else {
                                    md_osdb[os] = 1;
                                }
                            }
                            if (name != null) {
                                if (md_name[name]) {
                                    md_name[name] += 1;
                                } else {
                                    md_name[name] = 1;
                                }
                            }
                        }

                        /*
                        if (r!=null) {
                            if (r.family.indexOf("Other")==-1) {
                                if (familydb[r.family]) {
                                   familydb[r.family] += 1;
                                } else {
                                   familydb[r.family] = 1;
                                }
                                bestFamily = r.family;
                            } else if (r.os.indexOf("Other")==-1) {
                                bestOS = r.os;
                            }
                            break;
                        }
                        */
                    }
                    log.debug("Sorting", JSON.stringify(md_name), JSON.stringify(md_osdb))
                    let bestOS = null;
                    let bestName = null;
                    let osarray = [];
                    let namearray = [];
                    for (let i in md_osdb) {
                        osarray.push({
                            name: i,
                            rank: md_osdb[i]
                        });
                    }
                    for (let i in md_name) {
                        namearray.push({
                            name: i,
                            rank: md_name[i]
                        });
                    }
                    osarray.sort(function (a, b) {
                        return Number(b.rank) - Number(a.rank);
                    })
                    namearray.sort(function (a, b) {
                        return Number(b.rank) - Number(a.rank);
                    })
                    if (namearray.length > 0) {
                        this.o.ua_name = namearray[0].name;
                        this.predictedName = "(?)" + this.o.ua_name;

                        if (osarray.length > 0) {
                            this.o.ua_os_name = osarray[0].name;
                            this.predictedName += "/" + this.o.ua_os_name;
                        }
                        this.o.pname = this.predictedName;
                        log.debug(">>>>>>>>>>>> ", this.predictedName, JSON.stringify(this.o.ua_os_name));
                    }
                    if (mobile == true) {
                        this.o.deviceClass = "mobile";
                        this.save("deviceClass", null);
                    }
                    if (this.o.ua_os_name) {
                        this.save("ua_os_name", null);
                    }
                    if (this.o.ua_name) {
                        this.save("ua_name", null);
                    }
                    if (this.o.pname) {
                        this.save("pname", null);
                    }
                    //this.save("ua_name",null);

                    /*
                    if (bestFamily!=null) {
                        this.hostname = "(?)"+bestFamily;
                    } else if (bestOS!=null) {
                        this.hostname = "(?)"+bestOS;
                    }
                    log.info(this.o.name,this.hostname);
                    if (this.hostname!=null && this.o.name!=this.hostname) {
                        //this.o.name = this.hostname;
                        this.save("name",null);
                    }
                   */
                }
            });

            /*
                        rclient.smembers("host:user_agent:"+this.o.ipv4Addr,(err,results)=> {
                            if (results!=null && results.length>0) {
                                let bestFamily = null;
                                let bestOS = null;
                                for (let i in results) {
                                    let r = JSON.parse(results[i]);
                                    if (r!=null) {
                                        if (r.family.indexOf("Other")==-1) {
                                            bestFamily = r.family;
                                        } else if (r.os.indexOf("Other")==-1) {
                                            bestOS = r.os;
                                        }
                                        break;
                                    }
                                }
                                if (bestFamily!=null) {
                                    this.hostname = "(?)"+bestFamily;
                                } else if (bestOS!=null) {
                                    this.hostname = "(?)"+bestOS;
                                }
                                log.info(this.o.name,this.hostname);
                                if (this.hostname!=null && this.o.name!=this.hostname) {
                                    //this.o.name = this.hostname;
                                    this.save("name",null);
                                }
                            }
                        });
            */

        }
    }

    hasBeenGivenName() {
        if (this.o.name == null) {
            return false;
        }
        if (this.o.name == this.o.ipv4Addr || this.o.name.indexOf("(?)") != -1 || this.o.name == "undefined") {
            return false;
        }
        return true;
    }

    saveAsync(tuple) {
        return new Promise((resolve, reject) => {
            this.save(tuple,(err, data) => {
                if(err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    save(tuple, callback) {
        if (tuple == null) {
            this.redisfy();
            rclient.hmset("host:mac:" + this.o.mac, this.o, (err) => {
                if (callback) {
                    callback(err);
                }
            });
        } else {
            this.redisfy();
            log.debug("Saving ", this.o.ipv4Addr, tuple, this.o[tuple]);
            let obj = {};
            obj[tuple] = this.o[tuple];
            rclient.hmset("host:mac:" + this.o.mac, obj, (err) => {
                if (callback) {
                    callback(err);
                }
            });
        }
    }

    setAdmin(tuple, value) {
        if (this.admin == null) {
            this.admin = {};
        }
        this.admin[tuple] = value;
        this.redisfy();

        rclient.hmset("host:mac:" + this.o.mac, {
            'admin': this.o.admin
        });
    }

    getAdmin(tuple) {
        if (this.admin == null) {
            return null;
        }
        return this.admin[tuple];
    }

    parse() {
        if (this.o.ipv6Addr) {
            this.ipv6Addr = JSON.parse(this.o.ipv6Addr);
        } else {}
        if (this.o.admin) {
            this.admin = JSON.parse(this.o.admin);
        } else {}
        if (this.o.dtype) {
            this.dtype = JSON.parse(this.o.dtype);
        }
        if (this.o.activities) {
            this.activities= JSON.parse(this.o.activities);
        }
    }

    redisfy() {
        if (this.ipv6Addr) {
            this.o.ipv6Addr = JSON.stringify(this.ipv6Addr);
        }
        if (this.admin) {
            this.o.admin = JSON.stringify(this.admin);
        }
        if (this.dtype) {
            this.o.dtype = JSON.stringify(this.dtype);
        }
        if (this.activities) {
            this.o.activities= JSON.stringify(this.activities);
        }
    }

    touch(date) {
        if (date != null || date <= this.o.lastActiveTimestamp) {
            return;
        }
        if (date == null) {
            date = Date.now() / 1000;
        }
        this.o.lastActiveTimestamp = date;
        rclient.hmset("host:mac:" + this.o.mac, {
            'lastActiveTimestamp': this.o.lastActiveTimestamp
        });
    }

  getAllIPs() {
    let list = [];
    list.push(this.o.ipv4Addr);
    if (this.ipv6Addr && this.ipv6Addr.length > 0) {
      for (let j in this['ipv6Addr']) {
        list.push(this['ipv6Addr'][j]);
      }
    }
    return list;
  }


    spoof(state) {
        log.debug("Spoofing ", this.o.ipv4Addr, this.ipv6Addr, this.o.mac, state, this.spoofing);
        if (this.o.ipv4Addr == null) {
            log.info("Host:Spoof:NoIP", this.o);
            return;
        }
        log.debug("Host:Spoof:", state, this.spoofing);
        let gateway = sysManager.monitoringInterface().gateway;
        let gateway6 = sysManager.monitoringInterface().gateway6;

      if(fConfig.newSpoof) {
        // new spoof supports spoofing on same device for mutliple times,
        // so no need to check if it is already spoofing or not
        if (this.o.ipv4Addr == gateway || this.o.mac == null || this.o.ipv4Addr == sysManager.myIp()) {
          return;
        }
        if (this.o.mac == "00:00:00:00:00:00" || this.o.mac.indexOf("00:00:00:00:00:00")>-1) {
          return;
        }
        if (this.o.mac == "FF:FF:FF:FF:FF:FF" || this.o.mac.indexOf("FF:FF:FF:FF:FF:FF")>-1) {
          return;
        }
        if(state === true) {
          spoofer.newSpoof(this.o.ipv4Addr)
            .then(() => {
            log.debug("Started spoofing", this.o.ipv4Addr);
            this.spoofing = true;
            }).catch((err) => {
            log.error("Failed to spoof", this.o.ipv4Addr);
          })
        } else {
          spoofer.newUnspoof(this.o.ipv4Addr)
            .then(() => {
              log.debug("Stopped spoofing", this.o.ipv4Addr);
              this.spoofing = false;
            }).catch((err) => {
            log.error("Failed to unspoof", this.o.ipv4Addr);
          })
        }

        /* put a safety on the spoof */
        log.debug("Spoof For IPv6",this.o.mac, JSON.stringify(this.ipv6Addr),JSON.stringify(this.o.ipv6Addr),{});
        let myIp6 = sysManager.myIp6();
        if (this.ipv6Addr && this.ipv6Addr.length>0) {
            for (let i in this.ipv6Addr) {
                if (this.ipv6Addr[i] == gateway6) {
                    continue;
                }
                if (myIp6 && myIp6.indexOf(this.ipv6Addr[i])>-1) {
                    continue;
                }
                if (state == true) {
                    spoofer.newSpoof6(this.ipv6Addr[i]).then(()=>{
                         log.debug("Starting v6 spoofing", this.ipv6Addr[i]);
                    }).catch((err)=>{
                         log.error("Failed to spoof", this.ipv6Addr);
                    })
                    if (i>20) {
                         log.error("Failed to Spoof, over ",i, " of ", this.ipv6Addr,{});
                         break;
                    }
                    // prototype
                 //   log.debug("Host:Spoof:True", this.o.ipv4Addr, gateway,this.ipv6Addr,gateway6);
                 //   spoofer.spoof(null, null, this.o.mac, this.ipv6Addr,gateway6);
                 //   this.spoofing = true;
                } else {
                    spoofer.newUnspoof6(this.ipv6Addr[i]).then(()=>{
                         log.debug("Starting v6 unspoofing", this.ipv6Addr[i]);
                    }).catch((err)=>{
                         log.error("Failed to [v6] unspoof", this.ipv6Addr);
                    })
                //    log.debug("Host:Spoof:False", this.o.ipv4Addr, gateway, this.ipv6Addr,gateway6);
                //    spoofer.unspoof(null, null, this.o.mac,this.ipv6Addr, gateway6);
                //    this.spoofing = false;
                }
           }
        }
      } else {
/*
        if (state === true && this.spoofing === false) {
          log.info("Host:Spoof:True", this.o.ipv4Addr, gateway,this.ipv6Addr,gateway6);
          spoofer.spoof(this.o.ipv4Addr, gateway, this.o.mac, this.ipv6Addr,gateway6);
          this.spoofing = true;
        } else if (state === false && this.spoofing === true) {
          log.info("Host:Spoof:False", this.o.ipv4Addr, gateway, this.ipv6Addr,gateway6);
          spoofer.unspoof(this.o.ipv4Addr, gateway, this.o.mac,this.ipv6Addr, gateway6);
          this.spoofing = false;
        }
*/
      }
    }

    // Notice
    processNotifications(channel, message) {
        log.debug("RX Notifcaitons", channel, message);
        if (channel.toLowerCase().indexOf("notice") >= 0) {
            if (this.callbacks.notice != null) {
                this.callbacks.notice(this, channel, message);
            }
        }
    }

    /*
    {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
    .indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
    */
    subscribe(ip, e) {
        this.subscriber.subscribe("DiscoveryEvent", e, ip, (channel, type, ip, obj) => {
            log.debug("Host:Subscriber", channel, type, ip, obj);
            if (type == "Notice:Detected") {
                if (this.callbacks[e]) {
                    this.callbacks[e](channel, ip, type, obj);
                }
            } else if (type == "Intel:Detected") {
                let hip = obj['id.resp_h'];
                let dip = obj['id.orig_h'];
                if (sysManager.isLocalIP(obj['id.orig_h']) == false) {
                    hip = obj['id.orig_h'];
                    dip = obj['id.resp_h'];
                }
                log.debug("Host:Subscriber:Intel", hip);
                if (sysManager.isLocalIP(hip) == true || sysManager.ignoreIP(hip) == true) {
                    log.error("Host:Subscriber:Intel Error related to local ip", hip);
                    return;
                }

                // damp the notifications a bit
                let intel = obj['id.resp_h'] + obj['id.orig_h'];
                if (this.lastIntel != null && this.lastIntel == intel) {
                    log.info("Host:Subscriber:Intel:Damp ", this.lastIntel);
                    return;
                } else {
                    this.lastIntel = intel;
                    setTimeout(() => {
                        this.lastIntel = null;
                    }, 3000);
                }
                dnsManager.resolveRemoteHost(hip, (err, name) => {
                    log.debug("Host:Subscriber:Intel:Resolved", hip, name);
                    if (name != null) {
                        obj['target_host_name'] = name;
                    }
                    intelManager.lookup(hip, (err, iobj, url) => {
                        log.debug("Host:Subscriber:Intel:Lookup", hip, url);
                        if (err != null || iobj == null) {
                            log.error("Host:Subscriber:Intel:NOTVERIFIED", hip);
                            return;
                        }

                        if (iobj.severityscore < 4) {
                            log.error("Host:Subscriber:Intel:NOTSCORED", iobj);
                            return;
                        }

                        obj.alarmtype = "intel";

                        if (iobj.severityscore > 50) {
                            obj.alarmseverity = "major";
                        } else {
                            obj.alarmseverity = "minor";
                        }

                        if (err == null && iobj != null) {
                            obj['intel'] = iobj;
                            obj['intelurl'] = url;
                        }

                        let actionobj = {
                            title: "Warning",
                            actions: ["block","ignore"],
                            src: "0.0.0.0",
                            dst: hip,
                            target:"0.0.0.0",
                            //info: "",
                            cmd: {
                                type: "jsonmsg",
                                mtype: "set",
                                target: "0.0.0.0",
                                data: {
                                    item: 'policy',
                                    value: {
                                        acl: {
                                            src: "0.0.0.0",
                                            dst: hip,
                                            state: true
                                        }
                                    }
                                }
                            }
                        }

                        log.debug("Host:Subscriber:Intel:Write", obj);

                        if (alarmManager == null) {
                            let AlarmManager = require("./AlarmManager.js");
                            alarmManager = new AlarmManager("info");
                        }
                        alarmManager.alarm(hip, "intel", obj.alarmseverity, iobj.severityscore, obj, actionobj, (err, data) => {
                            if (this.callbacks[e]) {
                                log.debug("Callbacks: ", channel, ip, type, obj);
                                this.callbacks[e](channel, ip, type, obj);
                            } else {
                                log.debug("No callbacks with ", e, this.callbacks);
                            }
                        });

                        // Alarms are stored as alarm:ip4:<ip> //timestamp//data
                        /*
                        let key = "alarm:ip4:"+hip;
                        obj['id']=uuid.v4();
                        let redisObj = [key,obj.ts,JSON.stringify(obj)];
                        log.debug("alarm:ip4:",redisObj);
                        rclient.zadd(redisObj,(err,response)=>{
                            if (err) {
                                log.error("alarm:save:error", err);
                            } else {
                                rclient.expireat(key, parseInt((+new Date)/1000) + 60*60*24*7);
                            }
                            if (this.callbacks[e]) {
                                log.debug("Callbacks: ",channel,ip,type,obj);
                                this.callbacks[e](channel,ip,type,obj);
                            } else {
                                log.debug("No callbacks with ",e,this.callbacks);
                            }
                        });

                        let key2 = "alarm:ip4:0.0.0.0";
                        rclient.zadd([key2,obj.ts,JSON.stringify(obj)],(err,response)=>{
                            if (err) {
                                log.error("alarm:save:error", err,key2);
                            }
                        });
                        */
                    });
                });
            } else if (type == "HostPolicy:Changed" && this.type == "server") {
                this.applyPolicy((err)=>{
                });
                log.info("HostPolicy:Changed", channel, ip, type, obj);
   /*
                this.loadPolicy((err, data) => {
                    log.debug("HostPolicy:Changed", JSON.stringify(this.policy));
                    policyManager.execute(this, this.o.ipv4Addr, this.policy, (err) => {
                        dnsManager.queryAcl(this.policy.acl,(err,acls)=> {
                            policyManager.executeAcl(this, this.o.ipv4Addr, acls, (err, changed) => {
                                if (err == null && changed == true) {
                                    this.savePolicy(null);
                                }
                            });
                        });
                    });
                });
*/
            }
        });
    }

    applyPolicy(callback) {
        this.loadPolicy((err, data) => {
            log.debug("HostPolicy:Changed", JSON.stringify(this.policy));
            let policy = JSON.parse(JSON.stringify(this.policy));
            // check for global
            if (this.mgr.policy.monitor != null && this.mgr.policy.monitor == false) {
                policy.monitor = false;
            }
            policyManager.execute(this, this.o.ipv4Addr, policy, (err) => {
                dnsManager.queryAcl(this.policy.acl,(err,acls)=> {
                    policyManager.executeAcl(this, this.o.ipv4Addr, acls, (err, changed) => {
                        if (err == null && changed == true) {
                            this.savePolicy(callback);
                        } else {
                            if (callback) {
                               callback(null,null);
                            }
                        }
                    });
                });
            });
        });
    }

    // type:
    //  { 'human': 0-100
    //    'type': 'Phone','desktop','server','thing'
    //    'subtype: 'ipad', 'iphone', 'nest'
    //
    calculateDType(callback) {
        rclient.smembers("host:user_agent:" + this.o.ipv4Addr, (err, results) => {
            if (results != null) {
                let human = results.length / 100.0;
                this.dtype = {
                    'human': human
                };
                this.save();
                if (callback) {
                    callback(null, this.dtype);
                }
            } else {
                if (callback) {
                    callback(err, null);
                }
            }
            this.syncToMac(null);
        });
    }

    /*
    {
       deviceClass: mobile, thing, computer, other, unknown
       human: score
    }
    */
    /* produce following
     *
     * .o._identifyExpiration : time stamp
     * .o._devicePhoto: "http of photo"
     * .o._devicePolicy: <future>
     * .o._deviceType:
     * .o._deviceClass:
     *
     * this is for device identification only.
     */

    packageTopNeighbors(count, callback) {
        let nkey = "neighbor:"+this.o.mac;
        rclient.hgetall(nkey,(err,neighbors)=> {
            if (neighbors) {
                let neighborArray = [];
                for (let i in neighbors) {
                     let obj = JSON.parse(neighbors[i]);
                     obj['ip']=i;
                     neighborArray.push(obj);
                     count--;
                }
                neighborArray.sort(function (a, b) {
                    return Number(b.count) - Number(a.count);
                })
                callback(err, neighborArray.slice(0,count));
            } else {
                callback(err, null);
            }
        });

    }

//'17.249.9.246': '{"neighbor":"17.249.9.246","cts":1481259330.564,"ts":1482050353.467,"count":348,"rb":1816075,"ob":1307870,"du":10285.943863000004,"name":"api-glb-sjc.smoot.apple.com"}


    hashNeighbors(neighbors) {
        let _neighbors = JSON.parse(JSON.stringify(neighbors));
        let debug =  sysManager.isSystemDebugOn() || !f.isProduction();
        for (let i in _neighbors) {
            let neighbor = _neighbors[i];
            neighbor._neighbor = flowUtil.hashIp(neighbor.neighbor);
            neighbor._name = flowUtil.hashIp(neighbor.name);
            if (debug == false) {
                delete neighbor.neighbor;
                delete neighbor.name;
                delete neighbor.ip;
            }
        }

        return _neighbors;
    }

    identifyDevice(force, callback) {
        if (this.mgr.type != "server") {
            if (callback)
                callback(null, null);
            return;
        }
        if (force==false  && this.o._identifyExpiration != null && this.o._identifyExpiration > Date.now() / 1000) {
            log.debug("HOST:IDENTIFY too early", this.o._identifyExpiration);
            if (callback)
                callback(null, null);
            return;
        }
        log.info("HOST:IDENTIFY",this.o.mac);
        // need to have if condition, not sending too much info if the device is ...
        // this may be used initially _identifyExpiration

        let obj = {
            deviceClass: 'unknown',
            human: this.dtype,
            vendor: this.o.macVendor,
            ou: this.o.mac.slice(0,13),
            uuid: flowUtil.hashMac(this.o.mac),
            _ipv4: flowUtil.hashIp(this.o.ipv4),
            ipv4: this.o.ipv4,
            firstFoundTimestamp: this.o.firstFoundTimestamp,
            lastActiveTimestamp: this.o.lastActiveTimestamp,
            bonjourName: this.o.bonjourName,
            dhcpName: this.o.dhcpName,
            ssdpName: this.o.ssdpName,
            bname: this.o.bname,
            pname: this.o.pname,
            ua_name : this.o.ua_name,
            ua_os_name : this.o.ua_os_name,
            name : this.name()
        };
        if (this.o.deviceClass == "mobile") {
            obj.deviceClass = "mobile";
        }
        try {
            this.packageTopNeighbors(60,(err,neighbors)=>{
                if (neighbors) {
                    obj.neighbors = this.hashNeighbors(neighbors);
                }
                rclient.smembers("host:user_agent:" + this.o.ipv4Addr, (err, results) => {
                    if (results != null) {
                        obj.agents = results;
                        bone.device("identify", obj, (err, data) => {
                            if (data != null) {
                                log.debug("HOST:IDENTIFY:RESULT", this.name(), data);

                                // pretty much set everything from cloud to local
                                for (let field in data) {
                                    let value = data[field]
                                    if(value.constructor.name === 'Array' ||
                                      value.constructor.name === 'Object') {
                                      this.o[field] = JSON.stringify(value) 
                                    } else {
                                      this.o[field] = value
                                    }
                                }

                                if (data._vendor!=null && this.o.macVendor == null) {
                                    this.o.macVendor = data._vendor;
                                }
                                if (data._name!=null) {
                                    this.o.pname = data._name;
                                }
                                if (data._deviceType) {
                                    this.o._deviceType = data._deviceType
                                }
                                this.save();
                            }
                        });
                    } else {
                        if (callback) {
                            callback(err, obj);
                        }
                    }
                });
            });
        } catch (e) {
            log.error("HOST:IDENTIFY:ERROR", obj, e);
            if (callback) {
                 callback(e, null);
            }
        }
        return obj;
    }

    // sync properties to mac address, macs will not change ip's will
    //
    syncToMac(callback) {
        //TODO
        /*
                if (this.o.mac) {
                    let mackey = "host:mac:"+this.o.mac.toUpperCase();
                        rclient.hgetall(key, (err,data)=> {
                            if ( err == null) {
                                if (data!=null) {
                                    data.ipv4 = host.ipv4Addr;
                                    data.lastActiveTimestamp = Date.now()/1000;
                                    if (host.macVendor) {
                                        data.macVendor = host.macVendor;
                                    }
                               } else {
                                   data = {};
                                   data.ipv4 = host.ipv4Addr;
                                   data.lastActiveTimestamp = Date.now()/1000;
                                   data.firstFoundTimestamp = data.lastActiveTimestamp;
                                   if (host.macVendor) {
                                        data.macVendor = host.macVendor;
                                   }
                               }
                               rclient.hmset(key,data, (err,result)=> {
                         });

                }
        */

    }


    listen(tell) {}

    stopListen() {}

    clean() {
        this.callbacks = {};
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    name() {
        return dnsManager.name(this.o);
        /*
                if (this.hasBeenGivenName() == true) {
                    return this.o.name;
                }
                if (this.o.bname) {
                    return this.o.bname;
                }
                if (this.predictedName) {
                    return this.predictedName;
                }
                if (this.hostname) {
                    return this.hostname;
                }
                let name = this.o.ipv4Addr;
                if (this.o.name != null) {
                    name = this.o.name;
                   return name;
                } else if (this.o.macVendor != null) {
                    name = "(?)"+this.o.macVendor;
                  return name;
                }

                return  this.o.ipv4Addr;
        */
    }


    toShortString() {
        let name = this.name();
        if (name == null) {
            name = "unknown";
        }
        let ip = this.o.ipv4Addr;

        let now = Date.now() / 1000;
        return ip + "\t" + name + " (" + Math.ceil((now - this.o.lastActiveTimestamp) / 60) + "m)" + " " + this.o.mac;
    }

  getPreferredBName() {

    // TODO: preferred name needs to be improved in the future
    if(this.o.dhcpName) {
      return this.o.dhcpName
    }
    
    if(this.o.bonjourName) {
      return this.o.bonjourName
    }


    return this.o.bname
  }

  getNameCandidates() {
    let names = []

    if(this.o.dhcpName) {
      names.push(this.o.dhcpName)
    }

    if(this.o.nmapName) {
      names.push(this.o.nmapName)
    }

    if(this.o.bonjourName) {
      names.push(this.o.bonjourName)
    }

    if(this.o.ssdpName) {
      names.push(this.o.ssdpName)    
    }

    if(this.o.bname) {
      names.push(this.o.bname)
    }

    return names.filter((value, index, self) => self.indexOf(value) === index)
  }

    toJson() {
        let json = {
          dtype: this.dtype,
          ip: this.o.ipv4Addr,
          ipv6: this.ipv6Addr,
          mac: this.o.mac,
          lastActive: this.o.lastActiveTimestamp,
          firstFound: this.firstFoundTimestamp,
          macVendor: this.o.macVendor,
          recentActivity: this.o.recentActivity,
          manualSpoof: this.o.manualSpoof,
          dhcpName: this.o.dhcpName,
          bonjourName: this.o.bonjourName,
          nmapName: this.o.nmapName,
          ssdpName: this.o.ssdpName
        }

        if (this.o.ipv4Addr == null) {
            json.ip = this.o.ipv4;
        }

      let preferredBName = this.getPreferredBName()

        if (preferredBName) {
          json.bname = preferredBName
        }

        json.names = this.getNameCandidates()

        if (this.activities) {
            json.activities= this.activities;
        }

        if (this.o.name) {
            json.name = this.o.name;
        }

        if (this.o._deviceType) {
            json._deviceType = this.o._deviceType
        }

        if (this.o._deviceType_p) {
          json._deviceType_p = this.o._deviceType_p
        }

        if (this.o._deviceType_top3) {
          try {
            json._deviceType_top3 = JSON.parse(this.o._deviceType_top3)
          } catch(err) {
            log.error("Failed to parse device type top 3 info:", err, {})
          }          
        }
        
      if(this.o.modelName) {
        json.modelName = this.o.modelName
      }

      if(this.o.manufacturer) {
        json.manufacturer = this.o.manufacturer
      }

        if (this.hostname) {
            json._hostname = this.hostname
        }
        if (this.policy) {
            json.policy = this.policy;
        }
        if (this.flowsummary) {
            json.flowsummary = this.flowsummary;
        }

       // json.macVendor = this.name();

        return json;
    }

    summarizeSoftware(ip, from, to, callback) {
        rclient.zrevrangebyscore(["software:ip:" + ip, to, from], (err, result) => {
            let softwaresdb = {};
            if (err == null) {
                log.debug("SUMMARIZE SOFTWARE: ", ip, from, to, result.length);
                for (let i in result) {
                    let o = JSON.parse(result[i]);
                    let obj = softwaresdb[o.name];
                    if (obj == null) {
                        softwaresdb[o.name] = o;
                        o.lastActiveTimestamp = Number(o.ts);
                        o.count = 1;
                    } else {
                        if (obj.lastActiveTimestamp < Number(o.ts)) {
                            obj.lastActiveTimestamp = Number(o.ts);
                        }
                        obj.count += 1;
                    }
                }

                let softwares = [];
                for (let i in softwaresdb) {
                    softwares.push(softwaresdb[i]);
                }
                softwares.sort(function (a, b) {
                    return Number(b.count) - Number(a.count);
                })
                let softwaresrecent = softwares.slice(0);
                softwaresrecent.sort(function (a, b) {
                    return Number(b.lastActiveTimestamp) - Number(a.lastActiveTimestamp);
                })
                callback(null, softwares, softwaresrecent);
            } else {
                log.error("Unable to search software");
                callback(err, null, null);
            }

        });
    }

    summarizeHttpFlows(ip, from, to, callback) {
        rclient.zrevrangebyscore(["flow:http:in:" + ip, to, from, "LIMIT", 0, 1000], (err, results) => {
            if (err == null && results.length > 0) {
                for (let i in results) {
                    let flow
                }
            } else {
                log.error("Unable to search software");
                callback(err, null, null);
            }
        });
    }

    //This is an older function replaced by redisclean
    redisCleanRange(hours) {
        let now = Date.now() / 1000;
        rclient.zremrangebyrank("flow:conn:in:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
        rclient.zremrangebyrank("flow:conn:out:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
        rclient.zremrangebyrank("flow:http:out:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
        rclient.zremrangebyrank("flow:http:in:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
    }

    getHostAsync(ip) {
      return new Promise((resolve, reject) => {
        this.getHost(ip, (err, host) => {
          if(err) {
            reject(err);
          } else {
            resolve(host);
          }
        })
      })
    }

    getHost(ip, callback) {
        let key = "host:ip4:" + ip;
        log.debug("Discovery:FindHostWithIP", key, ip);
        let start = "-inf";
        let end = "+inf";
        let now = Date.now() / 1000;
        this.summarygap = Number(24);
        if (this.summarygap != null) {
            start = now - this.summarygap * 60 * 60;
            end = now;
        }
        rclient.hgetall(key, (err, data) => {
            if (err == null && data != null) {
                this.o = data;

                if(this.mgr.type === 'server') {
                  this.subscribe(ip, "Notice:Detected");
                  this.subscribe(ip, "Intel:Detected");
                }

                this.summarizeSoftware(ip, start, end, (err, sortedbycount, sortedbyrecent) => {
                    //      rclient.zrevrangebyscore(["software:ip:"+ip,'+inf','-inf'], (err,result)=> {
                    this.softwareByCount = sortedbycount;
                    this.softwareByRecent = sortedbyrecent;
                    rclient.zrevrangebyscore(["notice:" + ip, end, start], (err, result) => {
                        this.notice = result
                        rclient.zrevrangebyscore(["flow:http:in:" + ip, end, start, "LIMIT", 0, 10], (err, result) => {
                            this.http = result;
                            flowManager.summarizeConnections([ip], "in", end, start, "rxdata", 1, true,false, (err, result) => {
                                this.conn = result;
                                callback(null, this);
                            });
                        });
                    });
                });
            } else {
                log.error("Discovery:FindHostWithIP:Error", key, err);
                callback(err, null);
            }
        });
    }

    redisclean() {
      // deprecated, do nothing
    }

    // policy:mac:xxxxx
    setPolicy(name, data, callback) {
        if (name == "acl") {
            if (this.policy.acl == null) {
                this.policy.acl = [data];
            } else {
                let acls = JSON.parse(this.policy.acl);
                let found = false;
                if (acls) {
                    for (let i in acls) {
                        let acl = acls[i];
                        if (acl.src == data.src && acl.dst == data.dst) {
                            if (acl.add == data.add) {
                                callback(null, null);
                                log.debug("Host:setPolicy:Nochange", this.o.ipv4Addr, name, data);
                                return;
                            } else {
                                acl.add = data.add;
                                found = true;
                                log.debug("Host:setPolicy:Changed", this.o.ipv4Addr, name, data);
                            }
                        }
                    }
                }
                if (found == false) {
                    acls.push(data);
                }
                this.policy.acl = acls;
            }
        } else {
            if (this.policy[name] != null && this.policy[name] == data) {
                callback(null, null);
                log.debug("Host:setPolicy:Nochange", this.o.ipv4Addr, name, data);
                return;
            }
            this.policy[name] = data;
            log.debug("Host:setPolicy:Changed", this.o.ipv4Addr, name, data);
        }
        this.savePolicy((err, data) => {
            if (err == null) {
                let obj = {};
                obj[name] = data;
                if (this.subscriber) {
                    this.subscriber.publish("DiscoveryEvent", "HostPolicy:Changed", this.o.ipv4Addr, obj);
                }
                if (callback) {
                    callback(null, obj);
                }
            } else {
                if (callback) {
                    callback(null, null);
                }

            }
        });

    }


    policyToString() {
        if (this.policy == null || Object.keys(this.policy).length == 0) {
            return "No policy defined";
        } else {
            let msg = "";
            for (let k in this.policy) {
                msg += k + " : " + this.policy[k] + "\n";
            }
            return msg;
        }
    }

    savePolicy(callback) {
        let key = "policy:mac:" + this.o.mac;
        let d = {};
        for (let k in this.policy) {
            d[k] = JSON.stringify(this.policy[k]);
        }
        rclient.hmset(key, d, (err, data) => {
            if (err != null) {
                log.error("Host:Policy:Save:Error", key, err, {});
            }
            if (callback)
                callback(err, null);
        });

    }

    loadPolicy(callback) {
        let key = "policy:mac:" + this.o.mac;

        rclient.hgetall(key, (err, data) => {
            log.debug("Host:Policy:Load:Debug", key, data);
            if (err != null) {
                log.error("Host:Policy:Load:Error", key, err, {});
                if (callback) {
                    callback(err, null);
                }
            } else {
                if (data) {
                    this.policy = {};
                    for (let k in data) {
                        this.policy[k] = JSON.parse(data[k]);
                    }
                    if (callback)
                        callback(null, data);
                } else {
                    this.policy = {};
                    if (callback)
                        callback(null, null);
                }
            }
        });
    }

    isFlowAllowed(flow) {
        if (this.policy && this.policy.blockin == true) {
            return false;
        }
        return true;
    }
}


module.exports = class {
    // type is 'server' or 'client'
    constructor(name, type, loglevel) {
      loglevel = loglevel || 'info';

      if (instances[name] == null) {

        this.instanceName = name;
        this.hosts = {}; // all, active, dead, alarm
        this.hostsdb = {};
        this.hosts.all = [];
        this.callbacks = {};
        this.type = type;
        this.policy = {};
        sysManager.update((err) => {
          if (err == null) {
            log.info("System Manager Updated");
            if(!f.isDocker()) {
              spoofer = new Spoofer(sysManager.config.monitoringInterface, {}, false, true);
            }
          }
        });

        let c = require('./MessageBus.js');
        this.subscriber = new c(loglevel);

        // ONLY register for these events if hostmanager type IS server
        if(this.type === "server") {

          log.info("Subscribing Scan:Done event...")
            this.subscriber.subscribe("DiscoveryEvent", "Scan:Done", null, (channel, type, ip, obj) => {
                log.info("New Host May be added rescan");
                this.getHosts((err, result) => {
                    if (this.type === 'server') {
                        for (let i in result) {
                            //result[i].spoof(true);
                        }
                    }
                    if (this.callbacks[type]) {
                        this.callbacks[type](channel, type, ip, obj);
                    }
                });
            });
            this.subscriber.subscribe("DiscoveryEvent", "SystemPolicy:Changed", null, (channel, type, ip, obj) => {
                if (this.type != "server") {
                    return;
                };

                this.execPolicy();
                /*
                this.loadPolicy((err,data)=> {
                    log.debug("SystemPolicy:Changed",JSON.stringify(this.policy));
                    policyManager.execute(this,"0.0.0.0",this.policy,null);
                });
                */
                log.info("SystemPolicy:Changed", channel, ip, type, obj);
            });

            this.keepalive();
            setInterval(()=>{
                this.keepalive();
            },1000*60*5);
        }

            instances[name] = this;
        }
        return instances[name];
    }


    keepalive() {
        log.info("HostManager:Keepalive");
        for (let i in this.hostsdb) {
            if (i.startsWith("host:mac")) {
                let _h = this.hostsdb[i];
                _h.keepalive();
            }
        }
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    /*
        getHost4(ip,callback) {
            let key = "host:ip4:"+ip;
            log.debug("Discovery:FindHostWithIP",key,ip);
            rclient.hgetall(key, (err,data)=> {
                if (data == null || err!=null) {
                    callback(err, null);
                } else {
                    let host = new Host(data);
                    callback(null,host);
                }
            });
        }

    */

  basicDataForInit(json, options) {
    let networkinfo = sysManager.sysinfo[sysManager.config.monitoringInterface];
    json.network = networkinfo;

    sysManager.updateInfo();

    if(f.isDocker() &&
      ! options.simulator &&
        fConfig.docker &&
        fConfig.docker.hostIP
    ) {
      // if it is running inside docker, and app is not from simulator
      // use docker host as the network ip
      json.network.ip_address = fConfig.docker.hostIP;
    }

    json.cpuid = utils.getCpuId();

    if(sysManager.language) {
      json.language = sysManager.language;
    } else {
      json.language = 'en'
    }

    json.releaseType = f.getReleaseType()

    if(sysManager.timezone) {
      json.timezone = sysManager.timezone;
    }

    json.features = {
      archiveAlarm: true,
      alarmMoreItems: true,
      ignoreAlarm: true,
      reportAlarm: true
    }

    json.runtimeFeatures = fc.getFeatures()

    if(f.isDocker()) {
      json.docker = true;
    }

    let branch = f.getBranch()
    if(branch === "master") {
      json.isBeta = true
    } else {
      json.isBeta = false
    }

    json.cpuid = utils.getCpuId()
    json.updateTime = Date.now();
    if (sysManager.sshPassword) {
      json.ssh = sysManager.sshPassword;
    }
    if (sysManager.sysinfo.oper && sysManager.sysinfo.oper.LastScan) {
      json.lastscan = sysManager.sysinfo.oper.LastScan;
    }
    json.systemDebug = sysManager.isSystemDebugOn();
    json.version = sysManager.config.version;
    json.longVersion = f.getVersion();
    json.device = "Firewalla (beta)"
    json.publicIp = sysManager.publicIp;
    json.ddns = sysManager.ddns;
    json.secondaryNetwork = sysManager.sysinfo && sysManager.sysinfo[sysManager.config.monitoringInterface2];
    json.remoteSupport = frp.started;
    if(frp.started) {
      json.remoteSupportConnID = frp.port + ""
      json.remoteSupportPassword = json.ssh
    }
    json.license = sysManager.license;
    if(!json.license) {
        json.license = license.getLicense()
    }
    json.ept = sysManager.ept;
    if (sysManager.publicIp) {
      json.publicIp = sysManager.publicIp;
    }
    if (sysManager.upgradeEvent) {
      json.upgradeEvent = sysManager.upgradeEvent;
    }
  }


  hostsInfoForInit(json) {
    let _hosts = [];
    for (let i in this.hosts.all) {
      _hosts.push(this.hosts.all[i].toJson());
    }
    json.hosts = _hosts;
  }

  last24StatsForInit(json) {
    let download = flowManager.getLast24HoursDownloadsStats();
    let upload = flowManager.getLast24HoursUploadsStats();

    return Promise.join(download, upload, (d, u) => {
      json.last24 = { upload: u, download: d, now: Math.round(new Date() / 1000)};
      return new Promise((resolve) => resolve(json));
    });
  }

  policyDataForInit(json) {
    log.debug("Loading polices");

    return new Promise((resolve, reject) => {
      this.loadPolicy((err, data) => {
        if(err) {
          reject(err);
          return;
        }

        if (this.policy) {
          json.policy = this.policy;
        }
        resolve(json);
      });
    });
  }

  alarmDataForInit(json) {

    log.debug("Reading Alarms");
    if (alarmManager == null) {
      let AlarmManager = require("./AlarmManager.js");
      alarmManager = new AlarmManager("info");
    }

    return new Promise((resolve, reject) => {
      alarmManager.read("0.0.0.0", 60 * 60 * 12, null, null, null, (err, results) => {
        log.debug("Done Reading Alarms");
        if (err == null && results && results.length > 0) {
          json.alarms = [];
          for (let i in results) {
            let alarm = JSON.parse(results[i]);
            if(alarm.alarmtype === "intel") {
              if (alarm.intel && alarm.intel.results) {
                  delete alarm.intel.results; // trim intel details
              } else {
                  log.error("Alarm Clean Problems: ",JSON.stringify(alarm),results[i])
              }
            }

            if (alarm["id.orig_h"]) {
              let origHost = this.hostsdb["host:ip4:" + alarm["id.orig_h"]];
              let toHost = this.hostsdb["host:ip4:" + alarm["id.resp_h"]];
              alarm.hostName = alarm["id.orig_h"];
              if (origHost && origHost.name()) {
                alarm.hostName = origHost.name();
              } else if (toHost && toHost.name()) {
                alarm.hostName = toHost.name();
              }
            }
            json.alarms.push(alarm);
          }
          resolve(json);
        } else {
          if(err)
            reject(err);
          resolve(json);
        }
      });
    });
  }

  newAlarmDataForInit(json) {
    log.debug("Reading new alarms");

    return new Promise((resolve, reject) => {
      alarmManager2.loadActiveAlarms((err, list) => {
        if(err) {
          reject(err);
          return;
        }
        json.newAlarms = list;
        resolve(json);
      });
    });
  }

  natDataForInit(json) {
    log.debug("Reading nat data");

    return new Promise((resolve, reject) => {
      rclient.hgetall("sys:scan:nat", (err, data) => {
        if(err) {
          reject(err);
          return;
        }

        if (data) {
          json.scan = {};
          for (let d in data) {
            json.scan[d] = JSON.parse(data[d]);
            if(typeof json.scan[d].description === 'object') {
              json.scan[d].description = ""
            }
          }
        }

        resolve(json);
      });
    });
  }

  ignoredIPDataForInit(json) {
    log.debug("Reading ignored IP list");
    return new Promise((resolve, reject) => {
      this.loadIgnoredIP((err,ipdata)=>{
        if(err) {
          reject(err);
          return;
        }
        json.ignoredIP = ipdata;
        resolve(json);
      });
    });
  }

  boneDataForInit(json) {
    log.debug("Bone for Init");
    return new Promise((resolve, reject) => {
      f.getBoneInfo((err,boneinfo)=>{
        if(err) {
          reject(err);
          return;
        }
        json.boneinfo = boneinfo;
        resolve(json);
      });
    });
  }

  legacyStats(json) {
    log.debug("Reading legacy stats");
    return flowManager.getSystemStats()
      .then((flowsummary) => {
        json.flowsummary = flowsummary;
      });
  }

  legacyHostsStats(json) {
    log.debug("Reading host legacy stats");

    let promises = this.hosts.all.map((host) => flowManager.getStats2(host))
    return Promise.all(promises)
      .then(() => {
        return this.hostPolicyRulesForInit(json)
          .then(() => {
            this.hostsInfoForInit(json);
            return json;
          })
      });
  }

  modeForInit(json) {
    log.debug("Reading mode");
    return modeManager.mode()
      .then((mode) => {
        json.mode = mode;
      });
  }

  // what is blocked
  policyRulesForInit(json) {
    log.debug("Reading policy rules");
    return new Promise((resolve, reject) => {
      policyManager2.loadActivePolicys((err, rules) => {
        if(err) {
          reject(err);
          return;
        } else {

          let alarmIDs = rules.map((p) => p.aid);

          alarmManager2.idsToAlarms(alarmIDs, (err, alarms) => {
            if(err) {
              log.error("Failed to get alarms by ids:", err, {});
              reject(err);
              return;
            }

            for(let i = 0; i < rules.length; i ++) {
              if(rules[i] && alarms[i]) {
                rules[i].alarmMessage = alarms[i].localizedInfo();
                rules[i].alarmTimestamp = alarms[i].timestamp;
              }
            }

            json.policyRules = rules;
            resolve();
          });
        }
      });
    });
  }

  // whats is allowed
  exceptionRulesForInit(json) {
    log.debug("Reading exception rules");
    return new Promise((resolve, reject) => {
      exceptionManager.loadExceptions((err, rules) => {
        if(err) {
          reject(err);
        } else {

          let alarmIDs = rules.map((p) => p.aid);

          alarmManager2.idsToAlarms(alarmIDs, (err, alarms) => {
            if(err) {
              log.error("Failed to get alarms by ids:", err, {});
              reject(err);
              return;
            }

            for(let i = 0; i < rules.length; i ++) {
              if(rules[i] && alarms[i]) {
                rules[i].alarmMessage = alarms[i].localizedInfo();
                rules[i].alarmTimestamp = alarms[i].timestamp;
              }
            }

            json.exceptionRules = rules;
            resolve();
          });
        }
      });
    });
  }

  hostPolicyRulesForInit(json) {
    log.debug("Reading individual host policy rules");

    return new Promise((resolve, reject) => {
      _async.eachLimit(this.hosts.all, 10, (host, cb) => {
        host.loadPolicy(cb)
      }, (err) => {
        if(err) {
          log.error("Failed to load individual host policy rules", err, {});
          reject(err);
        } else {
          resolve(json);
        }
      });
    })
  }

  loadDDNSForInit(json) {
    log.debug("Reading DDNS");

    return async(() => {
      let ddnsString = await (rclient.hgetAsync("sys:network:info", "ddns"));
      if(ddnsString) {
        try {
          let ddns = JSON.parse(ddnsString);
          json.ddns = ddns;
        } catch(err) {
          log.error("Failed to parse ddns string:", ddnsString);
        }
      }
    })();
  }

  migrateStats() {
    let ipList = [];
    for(let index in this.hosts.all) {
      ipList.push.apply(ipList, this.hosts.all[index].getAllIPs());
    }

    ipList.push("0.0.0.0"); // system one

    // total ip list to migrate
    return Promise.all(ipList.map((ip) => flowManager.migrateFromOldTableForHost(ip)));
  }

    /* 
     * data here may be used to recover Firewalla configuration 
     */
    getCheckInAsync() {
        return async(() => {
          let json = {};
          let requiredPromises = [
            this.policyDataForInit(json),
            this.modeForInit(json),
            this.policyRulesForInit(json),
            this.exceptionRulesForInit(json),
            this.natDataForInit(json),
            this.ignoredIPDataForInit(json),
          ]

          this.basicDataForInit(json, {});

          await (requiredPromises);

          let firstBinding = await (rclient.getAsync("firstBinding"))
          if(firstBinding) {
            json.firstBinding = firstBinding
          }

          json.bootingComplete = await (f.isBootingComplete())

          // Delete anything that may be private
          if (json.ssh) delete json.ssh

          return json;
        })();
    }

    toJson(includeHosts, options, callback) {

      if(typeof options === 'function') {
          callback = options;
          options = {}
      }

      let json = {};

      this.getHosts(() => {

        async(() => {

          let requiredPromises = [
            this.last24StatsForInit(json),
            this.policyDataForInit(json),
            this.legacyHostsStats(json),
            this.modeForInit(json),
            this.policyRulesForInit(json),
            this.exceptionRulesForInit(json),
            this.newAlarmDataForInit(json),
            this.natDataForInit(json),
            this.ignoredIPDataForInit(json),
            this.boneDataForInit(json)
          ]

          this.basicDataForInit(json, options);

          await (requiredPromises);

          await (this.loadDDNSForInit(json));

          json.nameInNotif = await (rclient.hgetAsync("sys:config", "includeNameInNotification"))

          // for any pi doesn't have firstBinding key, they are old versions
          let firstBinding = await (rclient.getAsync("firstBinding"))
          if(firstBinding) {
            json.firstBinding = firstBinding
          }

          json.bootingComplete = await (f.isBootingComplete())

          if(!appTool.isAppReadyToDiscardLegacyFlowInfo(options.appInfo)) {
            await (this.legacyStats(json));
          }

          if(!appTool.isAppReadyToDiscardLegacyAlarm(options.appInfo)) {
            await (this.alarmDataForInit(json));
          }

          try {
            await (exec("sudo systemctl is-active firekick"))
            json.isBindingOpen = 1;
          } catch(err) {
            json.isBindingOpen = 0;
          }

        })().then(() => {
          callback(null, json);
        }).catch((err) => {
          log.error("Caught error when preparing init data: " + err);
          log.error(err.stack);
          //          throw err;
          callback(err);
        });
      });
    }

    getHostFast(ip) {
        if (ip == null) {
           return null;
        }

        return this.hostsdb["host:ip4:"+ip];
    }

  getHostFast6(ip6) {
    if(ip6) {
      return this.hostsdb[`host:ip6:${ip6}`]
    }

    return null
  }

    getHostAsync(ip) {
      return new Promise((resolve, reject) => {
        this.getHost(ip, (err, host) => {
          if(err) {
            reject(err);
          } else {
            resolve(host);
          }
        })
      })
    }

    getHost(ip, callback) {
      callback = callback || function() {}

        dnsManager.resolveLocalHost(ip, (err, o) => {
            if (o == null) {
                callback(err, null);
                return;
            }
            let host = this.hostsdb["host:ip4:" + o.ipv4Addr];
            if (host) {
                host.update(o);
                callback(err, host);
                return;
            }
            if (err == null && o != null) {
                host = new Host(o,this);
                host.type = this.type;
                //this.hosts.all.push(host);
              this.hostsdb['host:ip4:' + o.ipv4Addr] = host;

              let ipv6Addrs = host.ipv6Addr
              if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
                for(let i in ipv6Addrs) {
                  let ip6 = ipv6Addrs[i]
                  let key = `host:ip6:${ip6}`
                  this.hostsdb[key] = host
                }
              }

                if (this.hostsdb['host:mac:' + o.mac]) {
                    // up date if needed
                }
                callback(null, host);
            } else {
                callback(err, null);
            }
        });
    }

    // take hosts list, get mac address, look up mac table, and see if
    // ipv6 or ipv4 addresses needed updating

    syncHost(host, save, callback) {
        if (host.o.mac == null) {
            log.error("HostManager:Sync:Error:MacNull", host.o.mac, host.o.ipv4Addr, host.o);
            callback("mac", null);
            return;
        }
        let mackey = "host:mac:" + host.o.mac;
        host.identifyDevice(false,null);
        host.calculateDType((err, data) => {
            rclient.hgetall(mackey, (err, data) => {
                if (data == null || err != null) {
                    callback(err, null);
                    return;
                }
                if (data.ipv6Addr == null) {
                    callback(null, null);
                    return;
                }

                let ipv6array = JSON.parse(data.ipv6Addr);
                if (host.ipv6Addr == null) {
                    host.ipv6Addr = [];
                }

                let needsave = false;

                //log.debug("=======>",host.o.ipv4Addr, host.ipv6Addr, ipv6array);
                for (let i in ipv6array) {
                    if (host.ipv6Addr.indexOf(ipv6array[i]) == -1) {
                        host.ipv6Addr.push(ipv6array[i]);
                        needsave = true;
                    }
                }

                sysManager.setNeighbor(host.o.ipv4Addr);

                for (let j in host.ipv6Addr) {
                    sysManager.setNeighbor(host.ipv6Addr[j]);
                }

                host.redisfy();
                if (needsave == true && save == true) {
                    rclient.hmset(mackey, {
                        ipv6Addr: host.o.ipv6Addr
                    }, (err, data) => {
                        callback(err);
                    });
                } else {
                    callback(null);
                }
            });
        });
    }


  getHostsAsync() {
    return new Promise((resolve,reject) => {
      this.getHosts((err, hosts) => {
        if(err) {
          reject(err)
        } else {
          resolve(hosts)
        }
      })
    })
  }

  // super resource-heavy function, be careful when calling this
    getHosts(callback,retry) {
        log.info("hostmanager:gethosts:started");
        // ready mark and sweep
        if (this.getHostsActive == true) {
            log.info("hostmanager:gethosts:mutx");
            let stack = new Error().stack
            let retrykey = retry;
            if (retry == null) {
                retrykey = Date.now();
            }
            log.info("hostmanager:gethosts:mutx:stack:",retrykey, stack )
            setTimeout(() => {
                this.getHosts(callback,retrykey);
            },3000);
            return;
        }
        if (retry == null) {
            // let stack = new Error().stack
            // log.info("hostmanager:gethosts:mutx:first:", stack )
        } else {
            let stack = new Error().stack
            log.info("hostmanager:gethosts:mutx:last:", retry,stack )
        }
      this.getHostsActive = true;
      if(this.type === "server") {
        this.execPolicy();
      }
        for (let h in this.hostsdb) {
            if (this.hostsdb[h]) {
                this.hostsdb[h]._mark = false;
            }
        }
        rclient.keys("host:mac:*", (err, keys) => {
            let multiarray = [];
            for (let i in keys) {
                multiarray.push(['hgetall', keys[i]]);
            }
            let since = Date.now()/1000-60*60*24*7; // one week
            rclient.multi(multiarray).exec((err, replies) => {
                _async.eachLimit(replies,2, (o, cb) => {
                    if (sysManager.isLocalIP(o.ipv4Addr) && o.lastActiveTimestamp>since) {
                        //log.info("Processing GetHosts ",o);
                        if (o.ipv4) {
                            o.ipv4Addr = o.ipv4;
                        }
                        if (o.ipv4Addr == null) {
                          log.info("hostmanager:gethosts:error:noipv4", o.uid, o.mac,{});
                            cb();
                            return;
                        }
                        let hostbymac = this.hostsdb["host:mac:" + o.mac];
                        let hostbyip = this.hostsdb["host:ip4:" + o.ipv4Addr];

                        if (hostbymac == null) {
                            hostbymac = new Host(o,this);
                            hostbymac.type = this.type;
                            this.hosts.all.push(hostbymac);
                            this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
                          this.hostsdb['host:mac:' + o.mac] = hostbymac;

                          let ipv6Addrs = hostbymac.ipv6Addr
                          if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
                            for(let i in ipv6Addrs) {
                              let ip6 = ipv6Addrs[i]
                              let key = `host:ip6:${ip6}`
                              this.hostsdb[key] = hostbymac
                            }
                          }

                        } else {
                            if (o.ipv4!=hostbymac.o.ipv4) {
                                // the physical host get a new ipv4 address
                                //
                                this.hostsdb['host:ip4:' + hostbymac.o.ipv4] = null;
                            }
                          this.hostsdb['host:ip4:' + o.ipv4] = hostbymac;

                          let ipv6Addrs = hostbymac.ipv6Addr
                          if(ipv6Addrs && ipv6Addrs.constructor.name === 'Array') {
                            for(let i in ipv6Addrs) {
                              let ip6 = ipv6Addrs[i]
                              let key = `host:ip6:${ip6}`
                              this.hostsdb[key] = hostbymac
                            }
                          }

                          hostbymac.update(o);
                        }
                        hostbymac._mark = true;
                        if (hostbyip) {
                            hostbyip._mark = true;
                        }
                        // two mac have the same IP,  pick the latest, until the otherone update itself
                        if (hostbyip != null && hostbyip.o.mac != hostbymac.o.mac) {
                            log.info("HOSTMANAGER:DOUBLEMAPPING", hostbyip.o.mac, hostbymac.o.mac);
                            if (hostbymac.o.lastActiveTimestamp > hostbyip.o.lastActiveTimestamp) {
                                this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
                            }
                        }
                        hostbymac.cleanV6().then(()=>{
                            this.syncHost(hostbymac, true, (err) => {
                                if (this.type == "server") {
                                    hostbymac.applyPolicy((err)=>{
                                        hostbymac._mark = true;
                                        cb();
                                    });
                                } else {
                                   hostbymac._mark = true;
                                   cb();
                                }
                            });
                        });
                       /*
                        hostbymac.loadPolicy((err, policy) => {
                            this.syncHost(hostbymac, true, (err) => {
                                if (this.type == "server") {
                                    policyManager.execute(hostbymac, hostbymac.o.ipv4Addr, hostbymac.policy, (err, data) => {
                                        dnsManager.queryAcl(hostbymac.policy.acl,(err,acls)=> {
                                            policyManager.executeAcl(hostbymac, hostbymac.o.ipv4Addr, acls, (err, changed) => {
                                                if (err == null && changed == true) {
                                                    hostbymac.savePolicy(null);
                                                }
                                            });
                                        });
                                    });
                                }
                                cb();
                            });
                        });
                       */
                    } else {
                        cb();
                    }
                }, (err) => {
                    let removedHosts = [];
/*
                    for (let h in this.hostsdb) {
                        let hostbymac = this.hostsdb[h];
                        if (hostbymac) {
                            log.info("BEFORE CLEANING CHECKING MARKING:", h,hostbymac.o.mac,hostbymac._mark);
                        }
                    }
*/
                    let allIPv6Addrs = [];
                    let allIPv4Addrs = [];

                    let myIp = sysManager.myIp();

                    for (let h in this.hostsdb) {
                        let hostbymac = this.hostsdb[h];
                        if (hostbymac && h.startsWith("host:mac")) {
                            if (hostbymac.ipv6Addr!=null && hostbymac.ipv6Addr.length>0) {
                                if (hostbymac.ipv4Addr != myIp) {   // local ipv6 do not count
                                    allIPv6Addrs = allIPv6Addrs.concat(hostbymac.ipv6Addr);
                                }
                            }
                            if (hostbymac.o.ipv4Addr!=null && hostbymac.o.ipv4Addr != myIp) {
                                allIPv4Addrs.push(hostbymac.o.ipv4Addr);
                            }
                        }
                        if (this.hostsdb[h] && this.hostsdb[h]._mark == false) {
                            let index = this.hosts.all.indexOf(this.hostsdb[h]);
                            if (index!=-1) {
                                this.hosts.all.splice(index,1);
                                log.info("Removing host due to sweeping");
                            }
                            removedHosts.push(h);
                        }  else {
                           if (this.hostsdb[h]) {
                               //this.hostsdb[h]._mark = false;
                           }
                        }
                    }
                    for (let h in removedHosts) {
                        delete this.hostsdb[removedHosts[h]];
                    }
                    log.debug("hostmanager:removing:hosts", removedHosts);
                    this.hosts.all.sort(function (a, b) {
                        return Number(b.o.lastActiveTimestamp) - Number(a.o.lastActiveTimestamp);
                    })
                    this.getHostsActive = false;
                    if (this.type === "server") {
                       spoofer.validateV6Spoofs(allIPv6Addrs);
                       spoofer.validateV4Spoofs(allIPv4Addrs);
                    }
                    log.info("hostmanager:gethosts:done Devices: ",Object.keys(this.hostsdb).length," ipv6 addresses ",allIPv6Addrs.length );
                    callback(err, this.hosts.all);
                });
            });
        });
    }

  appendACL(name, data) {
    if (this.policy.acl == null) {
      this.policy.acl = [data];
    } else {
      let acls = this.policy.acl;
      let found = false;
      if (acls) {
        for (let i in acls) {
          let acl = acls[i];
          log.debug("comparing ", acl, data);
          if (acl.src == data.src && acl.dst == data.dst && acl.sport == data.sport && acl.dport == data.dport) {
            if (acl.state == data.state) {
              log.debug("System:setPolicy:Nochange", name, data);
              return;
            } else {
              acl.state = data.state;
              found = true;
              log.debug("System:setPolicy:Changed", name, data);
            }
          }
        }
      }
      if (found == false) {
        acls.push(data);
      }
      this.policy.acl = acls;
    }
  }

  setPolicy(name, data, callback) {

    let savePolicyWrapper = (name, data, callback) => {
      this.savePolicy((err, data) => {
        if (err == null) {
          let obj = {};
          obj[name] = data;
          if (this.subscriber) {
              this.subscriber.publish("DiscoveryEvent", "SystemPolicy:Changed", "0", obj);
          }
          if (callback) {
            callback(null, obj);
          }
        } else {
          if (callback) {
            callback(null, null);
          }
        }
      });
    }

    this.loadPolicy((err, __data) => {
      if (name == "acl") {
        // when adding acl, enrich acl policy with source IP => MAC address mapping.
        // so that iptables can block with MAC Address, which is more accurate
        //
        // will always associate a mac with the
        let localIP = null;
        if (sysManager.isLocalIP(data.src)) {
            localIP = data.src;
        }
        if (sysManager.isLocalIP(data.dst)) {
            localIP = data.dst;
        }

        if(localIP) {
          this.getHost(localIP, (err, host) => {
            if(!err) {
              data.mac = host.o.mac; // may add more attributes in the future
            }
            this.appendACL(name, data);
            savePolicyWrapper(name, data, callback);
          });
        } else {
          this.appendACL(name, data);
          savePolicyWrapper(name, data, callback);
        }

      } else {
        if (this.policy[name] != null && this.policy[name] == data) {
          if (callback) {
            callback(null, null);
          }
          log.debug("System:setPolicy:Nochange", name, data);
          return;
        }
        this.policy[name] = data;
        log.debug("System:setPolicy:Changed", name, data);

        savePolicyWrapper(name, data, callback);
      }

    });
  }

  spoof(state) {
    return async(() => {
      log.debug("System:Spoof:", state, this.spoofing);
      let gateway = sysManager.monitoringInterface().gateway;
      if (state == false) {
        // flush all ip addresses
        log.info("Flushing all ip addresses from monitoredKeys since monitoring is switched off")
        return spooferManager.emptySpoofSet()
      } else {
        // do nothing if state is true
      }
    })()
  }

    policyToString() {
        if (this.policy == null || Object.keys(this.policy).length == 0) {
            return "No policy defined";
        } else {
            let msg = "";
            for (let k in this.policy) {
                msg += k + " : " + this.policy[k] + "\n";
            }
            return msg;
        }
    }

    savePolicy(callback) {
        let key = "policy:system";
        let d = {};
        for (let k in this.policy) {
            d[k] = JSON.stringify(this.policy[k]);
        }
        rclient.hmset(key, d, (err, data) => {
            if (err != null) {
                log.error("Host:Policy:Save:Error", key, err);
            }
            if (callback)
                callback(err, null);
        });

    }

    loadPolicy(callback) {
        let key = "policy:system"
        rclient.hgetall(key, (err, data) => {
            if (err != null) {
                log.error("System:Policy:Load:Error", key, err);
                if (callback) {
                    callback(err, null);
                }
            } else {
                if (data) {
                    this.policy = {};
                    for (let k in data) {
                        this.policy[k] = JSON.parse(data[k]);
                    }
                    if (callback)
                        callback(null, data);
                } else {
                    this.policy = {};
                    if (callback)
                        callback(null, null);
                }
            }
        });
    }

    execPolicy() {
        this.loadPolicy((err, data) => {
            log.debug("SystemPolicy:Loaded", JSON.stringify(this.policy));
            if (this.type == "server") {
                policyManager.execute(this, "0.0.0.0", this.policy, (err) => {
                    dnsManager.queryAcl(this.policy.acl,(err,acls,ipchanged)=> {
                        policyManager.executeAcl(this, "0.0.0.0", acls, (err, changed) => {
                            if (ipchanged || (changed == true && err == null)) {
                                this.savePolicy(null);
                            }
                            for (let i in this.hosts.all) {
                                this.hosts.all[i].applyPolicy();
                            }
                        });
                    });
                });
            }
        });
    }

    loadIgnoredIP(callback) {
        let key = "policy:ignore"
        rclient.hgetall(key, (err, data) => {
            if (err != null) {
                log.error("Ignored:Policy:Load:Error", key, err);
                if (callback) {
                    callback(err, null);
                }
            } else {
                if (data) {
                    let ignored= {};
                    for (let k in data) {
                        ignored[k] = JSON.parse(data[k]);
                    }
                    if (callback)
                        callback(null, ignored);
                } else {
                    if (callback)
                        callback(null, null);
                }
            }
        });
    }

    unignoreIP(ip,callback) {
        let key = "policy:ignore";
        rclient.hdel(key,ip,callback);
        log.info("Unignore:",ip);
    }

    ignoreIP(ip,reason,callback) {
        let now = Math.ceil(Date.now() / 1000);
        let key = "policy:ignore";
        let obj = {
           ip: ip,
           ts: now,
       reason: reason
        };
        let objkey ={};
        objkey[ip]=JSON.stringify(obj);
        rclient.hmset(key,objkey,(err,data)=> {
            if (err!=null) {
                callback(err,null);
            } else {
                callback(null,null);
            }
        });
    }

    isIgnoredIP(ip,callback) {
        if (ip == null || ip == undefined) {
            callback(null,null);
            return;
        }
        if (ip.includes("encipher.io") || ip.includes("firewalla.com")) {
            callback(null,"predefined");
            return;
        }
        let key = "policy:ignore";
        rclient.hget(key,ip,(err,data)=> {
            callback(err,data);
        });
    }

    isIgnoredIPs(ips,callback) {
        let ignored = false;
        _async.each(ips, (ip, cb) => {
            this.isIgnoredIP(ip,(err,data)=>{
                if (err==null&& data!=null) {
                    ignored = true;
                }
                cb();
            });
        } , (err) => {
            log.info("HostManager:isIgnoredIPs:",ips,ignored);
            callback(null,ignored );
        });
    }

  // return a list of mac addresses that's active in last xx days
  getActiveMACs() {
    return this.hosts.all.map(h => h.o.mac).filter(mac => mac != null);
  }

  getActiveHostsFromSpoofList(limit) {
    return async(() => {
      let activeHosts = []

      let monitoredIP4s = await (rclient.smembersAsync("monitored_hosts"))

      for(let i in monitoredIP4s) {
        let ip4 = monitoredIP4s[i]
        let host = this.getHostFast(ip4)
        if(host && host.o.lastActiveTimestamp > limit) {
          activeHosts.push(host)
        }
      }

      let monitoredIP6s = await (rclient.smembersAsync("monitored_hosts6"))

      for(let i in monitoredIP6s) {
        let ip6 = monitoredIP6s[i]
        let host = this.getHostFast6(ip6)
        if(host && host.o.lastActiveTimestamp > limit) {
          activeHosts.push(host)
        }
      }

      // unique
      activeHosts = activeHosts.filter((elem, pos) => {
        return activeHosts.indexOf(elem) === pos
      })

      return activeHosts

    })()
  }

  cleanHostOperationHistory() {
    // reset oper history for each device
    if(this.hosts && this.hosts.all) {
      for(let i in this.hosts.all) {
        let h = this.hosts.all[i]
        if(h.oper) {
           delete h.oper
        }
      }
    }
  }


}
