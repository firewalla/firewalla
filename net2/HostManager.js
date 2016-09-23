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
var log;
var iptool = require('ip');
var os = require('os');
var network = require('network');
var instances = {};

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

var Spoofer = require('./Spoofer.js');
var spoofer = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');
var DNSManager = require('./DNSManager.js');
var dnsManager = new DNSManager('info');
var FlowManager = require('./FlowManager.js');
var flowManager = new FlowManager('debug');
var IntelManager = require('./IntelManager.js');
var intelManager = new IntelManager('debug');

var PolicyManager = require('./PolicyManager.js');
var policyManager = new PolicyManager('info');

var AlarmManager = require("./AlarmManager.js");
var alarmManager = new AlarmManager("info");

var uuid = require('uuid');
var bone = require("../lib/Bone.js");

var utils = require('../lib/utils.js');

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});
sclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');

var MobileDetect = require('mobile-detect');


/* alarms:
    alarmtype:  intel/newhost/scan/log
    severityscore: out of 100
    alarmseverity: major minor
*/


class Host {
    constructor(obj, callback) {
        this.callbacks = {};
        this.o = obj;
        if (this.o.ipv4) {
            this.o.ipv4Addr = this.o.ipv4;
        }
        this.spoofing = false;
        sclient.on("message", (channel, message) => {
            this.processNotifications(channel, message);
        });
        let c = require('./MessageBus.js');
        this.subscriber = new c('debug');
        if (obj != null) {
            this.subscribe(this.o.ipv4Addr, "Notice:Detected");
            this.subscribe(this.o.ipv4Addr, "Intel:Detected");
            this.subscribe(this.o.ipv4Addr, "HostPolicy:Changed");
        }
        this.spoofing = false;
        this.parse();
        /*
        if (this.o.ipv6Addr) {
            this.o.ipv6Addr = JSON.parse(this.o.ipv6Addr);
        }
        */
        this.predictHostNameUsingUserAgent();

        this.loadPolicy(callback);

    }

    update(obj) {
        this.o = obj;
        if (this.o.ipv4) {
            this.o.ipv4Addr = this.o.ipv4;
        }
        if (obj != null) {
            this.subscribe(this.o.ipv4Addr, "Notice:Detected");
            this.subscribe(this.o.ipv4Addr, "Intel:Detected");
            this.subscribe(this.o.ipv4Addr, "HostPolicy:Changed");
        }
        this.predictHostNameUsingUserAgent();
        this.loadPolicy(null);
        this.parse();
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
                                console.log("MD Null");
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
                    console.log(this.o.name,this.hostname);
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
                                console.log(this.o.name,this.hostname);
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
        } else {}
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

    spoof(state) {
        log.debug("Spoofing ", this.o.ipv4Addr, this.o.mac, state, this.spoofing);
        if (this.o.ipv4Addr == null) {
            log.info("Host:Spoof:NoIP", this.o);
            return;
        }
        log.debug("Host:Spoof:", state, this.spoofing);
        let gateway = sysManager.monitoringInterface().gateway;
        if (state == true && this.spoofing == false) {
            log.debug("Host:Spoof:True", this.o.ipv4Addr, gateway);
            spoofer.spoof(this.o.ipv4Addr, gateway, this.o.mac);
            this.spoofing = true;
        } else if (state == false && this.spoofing == true) {
            log.debug("Host:Spoof:False", this.o.ipv4Addr, gateway);
            spoofer.unspoof(this.o.ipv4Addr, gateway, true);
            this.spoofing = false;
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
                this.loadPolicy((err, data) => {
                    log.debug("HostPolicy:Changed", JSON.stringify(this.policy));
                    policyManager.execute(this, this.o.ipv4Addr, this.policy, (err) => {
                        dnsManager.queryAcl(this.policy.acl,(err,acls)=> {
                            policyManager.executeAcl(this, this.o.ipv4Addr, acls, (err, changed) => {
                                if (err == null && changed == true) {
                                    this.savePoicy(null);
                                }
                            });
                        });
                    });
                });
                log.info("HostPolicy:Changed", channel, ip, type, obj);
            }
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

    identifyDevice(force, callback) {
        log.debug("HOST:IDENTIFY",this.o.mac);
        if (force==false  && this.o._identifyExpiration != null && this.o._identifyExpiration > Date.now() / 1000) {
            log.debug("HOST:IDENTIFY too early", this.o._identifyExpiration);
            if (callback)
                callback(null, null);
            return;
        }
        // need to have if condition, not sending too much info if the device is ...  
        // this may be used initially _identifyExpiration 

        let obj = {
            deviceClass: 'unknown',
            human: this.dtype,
            vendor: this.o.macVendor,
            ou: this.o.mac.slice(0,8)
        };
        if (this.o.deviceClass == "mobile") {
            obj.deviceClass = "mobile";
            obj.ua_name = this.o.ua_name;
            obj.ua_os_name = this.o.ua_os_name;
            obj.name = this.name();
        }
        try {
            this.packageTopNeighbors(60,(err,neighbors)=>{ 
                if (neighbors) {
                    obj.neighbors = neighbors; 
                }
                rclient.smembers("host:user_agent:" + this.o.ipv4Addr, (err, results) => {
                    if (results != null) {
                        obj.agents = results;
                        bone.device("identify", obj, (err, data) => {
                            if (data != null) {
                                log.debug("HOST:IDENTIFY:RESULT", this.name(), data);
                                for (let field in data) {
                                    this.o[field] = data[field];
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


    toJson() {
        let json = {
            dtype: this.dtype,
            ip: this.o.ipv4Addr,
            ipv6: this.ipv6Addr,
            mac: this.o.mac,
            lastActive: this.o.lastActiveTimestamp,
            firstFound: this.firstFoundTimestamp,
            macVendor: this.o.macVendor
        }

        if (this.o.ipv4Addr == null) {
            json.ip = this.o.ipv4;
        }

        if (this.o.bname) {
            json.bname = this.o.bname;
        }

        if (this.o.name) {
            json.name = this.o.name;
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

        json.macVendor = this.name();
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
                this.subscribe(ip, "Notice:Detected");
                this.subscribe(ip, "Intel:Detected");
                this.summarizeSoftware(ip, start, end, (err, sortedbycount, sortedbyrecent) => {
                    //      rclient.zrevrangebyscore(["software:ip:"+ip,'+inf','-inf'], (err,result)=> {
                    this.softwareByCount = sortedbycount;
                    this.softwareByRecent = sortedbyrecent;
                    rclient.zrevrangebyscore(["notice:" + ip, end, start], (err, result) => {
                        this.notice = result
                        rclient.zrevrangebyscore(["flow:http:in:" + ip, end, start, "LIMIT", 0, 10], (err, result) => {
                            this.http = result;
                            flowManager.summarizeConnections([ip], "in", end, start, "rxdata", 1, true, (err, result) => {
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
        sysManager.redisclean();
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
                this.subscriber.publish("DiscoveryEvent", "HostPolicy:Changed", this.o.ipv4Addr, obj);
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
                log.error("Host:Policy:Save:Error", key, err);
            }
            callback(err, null);
        });

    }

    loadPolicy(callback) {
        let key = "policy:mac:" + this.o.mac;

        rclient.hgetall(key, (err, data) => {
            log.debug("Host:Policy:Load:Debug", key, data);
            if (err != null) {
                log.error("Host:Policy:Load:Error", key, err);
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
}


module.exports = class {
    // type is 'server' or 'client'
    constructor(name, type, loglevel) {
        if (instances[name] == null) {
            log = require("./logger.js")("discovery", loglevel);
            this.instanceName = name;
            this.hosts = {}; // all, active, dead, alarm
            this.hostsdb = {};
            this.hosts.all = [];
            this.callbacks = {};
            this.type = type;
            this.policy = {};
            sysManager.update((err) => {
                if (err == null) {
                    log.info("System Manager Updated", sysManager.config);
                    spoofer = new Spoofer(sysManager.config.monitoringInterface, {}, false, true);
                }
            });
            let c = require('./MessageBus.js');
            this.subscriber = new c(loglevel);
            this.subscriber.subscribe("DiscoveryEvent", "Scan:Done", null, (channel, type, ip, obj) => {
                log.info("New Host May be added rescan");
                sysManager.redisclean();
                this.getHosts((err, result) => {
                    if (this.type == 'server') {
                        for (let i in result) {
                            //result[i].spoof(true);
                        }
                    }
                });
                //this.hosts = {};
                //this.getHosts((err,hosts)=> {
                //});
                if (this.callbacks[type]) {
                    this.callbacks[type](channel, type, ip, obj);
                }
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

            instances[name] = this;
        }
        return instances[name];
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

    toJson(includeHosts, callback) {
        let networkinfo = sysManager.sysinfo[sysManager.config.monitoringInterface];
        let json = {
            network: networkinfo,
            cpuid: utils.getCpuId(),
        };
        if (sysManager.sysinfo.oper && sysManager.sysinfo.oper.LastScan) {
            json.lastscan = sysManager.sysinfo.oper.LastScan;
        }
        json.version = sysManager.config.version;
        json.device = "Firewalla (beta)"

        flowManager.summarizeBytes(this.hosts.all, Date.now() / 1000, Date.now() / 1000 - 60 * 30, 60 * 30 / 30, (err, sys) => {
            json.flowsummary = sys;
            if (includeHosts) {
                let _hosts = [];
                for (let i in this.hosts.all) {
                    _hosts.push(this.hosts.all[i].toJson());
                }
                json.hosts = _hosts;
            }

            let key = "alarm:ip4:0.0.0.0";
            log.debug("Loading polices");
            this.loadPolicy((err, data) => {
                if (this.policy) {
                    json.policy = this.policy;
                }
                log.debug("Reading Alarms");
                alarmManager.read("0.0.0.0", 60 * 60 * 12, null, null, null, (err, results) => {
                    //       rclient.zrevrangebyscore([key,Date.now()/1000,Date.now()/1000-60*60*24], (err,results)=> {
                    log.debug("Done Reading Alarms");
                    if (err == null && results && results.length > 0) {
                        json.alarms = [];
                        for (let i in results) {
                            let alarm = JSON.parse(results[i]);
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
                    }
                    rclient.hgetall("sys:scan:nat", (err, data) => {
                        if (data) {
                            json.scan = {};
                            for (let d in data) {
                                json.scan[d] = JSON.parse(data[d]);
                            }
                        }
                        callback(null, json);
                    });
                });
            });
        });
    }

    getHost(ip, callback) {
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
                host = new Host(o);
                host.type = this.type;
                //this.hosts.all.push(host);
                this.hostsdb['host:ip4:' + o.ipv4Addr] = host;
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
                if (data.ipv6 == null) {
                    callback(null, null);
                    return;
                }

                let ipv6array = JSON.parse(data.ipv6);
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


    getHosts(callback) {
        this.execPolicy();
        rclient.keys("host:mac:*", (err, keys) => {
            let multiarray = [];
            for (let i in keys) {
                multiarray.push(['hgetall', keys[i]]);
            }
            let since = Date.now()/1000-60*60*24*7*2; // two weeks
            rclient.multi(multiarray).exec((err, replies) => {
                async.each(replies, (o, cb) => {
                    if (sysManager.isLocalIP(o.ipv4Addr) && o.lastActiveTimestamp>since) {
                        //console.log("Processing GetHosts ",o);
                        if (o.ipv4) {
                            o.ipv4Addr = o.ipv4;
                        }
                        if (o.ipv4Addr == null) {
                            log.info("hostmanager:gethosts:error:noipv4", o);
                            cb();
                            return;
                        }
                        let hostbymac = this.hostsdb["host:mac:" + o.mac];
                        let hostbyip = this.hostsdb["host:ip4:" + o.ipv4Addr];

                        if (hostbymac == null) {
                            hostbymac = new Host(o);
                            hostbymac.type = this.type;
                            this.hosts.all.push(hostbymac);
                            this.hostsdb['host:ip4:' + o.ipv4Addr] = hostbymac;
                            this.hostsdb['host:mac:' + o.mac] = hostbymac;
                        } else {
                            hostbymac.update(o);
                        }
                        /*
                        if (hostbyip != null) {
                            if (hostbyip.mac != o.mac) {
                                hostbyip.mac = o.mac;
                            }
                            // need to take care of ip address change by checking mac
                        }
                        */
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
                    } else {
                        cb();
                    }
                }, (err) => {
                    this.hosts.all.sort(function (a, b) {
                        return Number(b.o.lastActiveTimestamp) - Number(a.o.lastActiveTimestamp);
                    })
                    callback(err, this.hosts.all);
                });
            });
        });
    }

    setPolicy(name, data, callback) {
        this.loadPolicy((err, __data) => {
            if (name == "acl") {
                if (this.policy.acl == null) {
                    this.policy.acl = [data];
                } else {
                    let acls = this.policy.acl;
                    let found = false;
                    if (acls) {
                        for (let i in acls) {
                            let acl = acls[i];
                            log.debug("comparing ", acl, data);
                            if (acl.src == data.src && acl.dst == data.dst) {
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
            }
            this.savePolicy((err, data) => {
                if (err == null) {
                    let obj = {};
                    obj[name] = data;
                    this.subscriber.publish("DiscoveryEvent", "SystemPolicy:Changed", "0", obj);
                    if (callback) {
                        callback(null, obj);
                    }
                } else {
                    if (callback) {
                        callback(null, null);
                    }

                }
            });
        });
    }

    spoof(state) {
        log.debug("System:Spoof:", state, this.spoofing);
        let gateway = sysManager.monitoringInterface().gateway;
        if (state == false) {} else {}
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
                    dnsManager.queryAcl(this.policy.acl,(err,acls)=> {
                        policyManager.executeAcl(this, "0.0.0.0", acls, (err, changed) => {
                            if (changed == true && err == null) {
                                this.savePolicy(null);
                            }
                        });
                    });
                });
            }
        });
    }
}
