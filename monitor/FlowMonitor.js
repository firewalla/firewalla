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
let log = require("../net2/logger.js")(__filename, 'info');
let os = require('os');
let network = require('network');

let redis = require("redis");
let rclient = redis.createClient();

let FlowManager = require('../net2/FlowManager.js');
let flowManager = new FlowManager('info');

let Alarm = require('../alarm/Alarm.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js');
let alarmManager2 = new AlarmManager2();

let audit = require('../util/audit.js');

const fc = require('../net2/config.js')

let uuid = require('uuid');

rclient.on("error", function (err) {
    log.error("Redis(alarm) Error " + err);
});

let async = require('async');
let instance = null;
let HostManager = require("../net2/HostManager.js");
let hostManager = new HostManager("cli", 'client', 'info');

let stddev_limit = 8;
let AlarmManager = require('../net2/AlarmManager.js');
let alarmManager = new AlarmManager('debug');

let IntelManager = require('../net2/IntelManager.js');
let intelManager = new IntelManager('debug');

let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager('info');

let DNSManager = require('../net2/DNSManager.js');
let dnsManager = new DNSManager('info');

let fConfig = require('../net2/config.js').getConfig();

const flowUtil = require('../net2/FlowUtil.js');

function getDomain(ip) {
    if (ip.endsWith(".com") || ip.endsWith(".edu") || ip.endsWith(".us") || ip.endsWith(".org")) {
        let splited = ip.split(".");
        if (splited.length>=3) {
            return (splited[splited.length-2]+"."+splited[splited.length-1]);
        }
    }
    return ip;
}



module.exports = class FlowMonitor {
    constructor(timeslice, monitorTime, loglevel) {
        this.timeslice = timeslice; // in seconds
        this.monitorTime = monitorTime;

        if (instance == null) {
            let c = require('../net2/MessageBus.js');
            this.publisher = new c(loglevel);
            this.recordedFlows = {};

            instance = this;
          log = require("../net2/logger.js")("FlowMonitor", loglevel);

          flowManager.last24HourDatabaseExists()
            .then((result) => {
              if(!result) {
                // need to migrate from legacy
                log.info("Migrating stats from old version to new version");
                hostManager.migrateStats()
                  .then(() => {
                    log.info("Stats are migrated to new format");
                  });
              }
            });
        }
        return instance;
    }

    // flow record is a very simple way to look back past n seconds,
    // if 'av' for example, shows up too many times ... likely to be
    // av

    flowIntelRecordFlow(flow,limit) {
        let key = flow.dh;
        if (flow["dhname"] != null) {
            key = getDomain(flow["dhname"]);
        }
        let record = this.recordedFlows[key];
        if (record) {
            record.ts = Date.now()/1000;
            record.count += flow.ct;
        } else {
            record = {}
            record.ts = Date.now()/1000;
            record.count = flow.ct;
            this.recordedFlows[key] = record;
        }
        // clean  up
        let oldrecords = [];
        for (let k in this.recordedFlows) {
           if (this.recordedFlows[k].ts < Date.now()/1000-60*5) {
               oldrecords.push(k);
           }
        }

        for (let i in oldrecords) {
           delete this.recordedFlows[oldrecords[i]];
        }

        log.info("FLOW:INTEL:RECORD", key,record,{});
        if (record.count>limit) {
            record.count = 0-limit;
            return true;
        }
        return false;
    }

    garbagecollect() {
      try {
        if (global.gc) {
          global.gc();
        }
      } catch(e) {
      }
    }

    checkIntelClass(intel,_class) {
        if (intel == null || _class == null) {
            return false;
        }

        const intelFeatureMapping = {
            "av": "video",
            "game": "game",
            "porn": "porn",
            "intel": "cyber_security"
        }

        const featureName = intelFeatureMapping[_class]
        if(!featureName) {
            return false
        }

        if(!fc.isFeatureOn(featureName)) {
          log.warn(`Feature ${featureName} is not enabled`)
            return false
        }

        if (intel.c) {
            if (intel.c == _class) {
                return true;
            }
        }
        if (intel.cs) {
            let cs = intel.cs;
            if (!Array.isArray(intel.cs)) {
                cs = JSON.parse(intel.cs);
            }
            if (cs.indexOf(_class)!=-1) {
                return true;
            }
        }
        return false;
    }

    flowIntel(flows) {
        for (let i in flows) {
            let flow = flows[i];
            log.debug("FLOW:INTEL:PROCESSING",JSON.stringify(flow),{});
            if (flow['intel'] && flow['intel']['c'] && flowUtil.checkFlag(flow,'l')==false) {
              log.info("########## flowIntel",JSON.stringify(flow),{});
              let c = flow['intel']['c'];
              let cs = flow['intel']['cs'];

              hostManager.isIgnoredIPs([flow.sh,flow.dh,flow.dhname,flow.shname],(err,ignore)=>{
               if (ignore == true) {
                   log.info("######## flowIntel:Ignored",flow);
               }

               if (ignore == false) {
                log.info("######## flowIntel Processing",JSON.stringify(flow));
                if (this.checkIntelClass(flow['intel'],"av")) {
                    if ( (flow.du && Number(flow.du)>60) && (flow.rb && Number(flow.rb)>5000000) ) {
                        let msg = "Watching video "+flow["shname"] +" "+flowUtil.dhnameFlow(flow);
                        let actionobj = {
                            title: "Video Watching",
                            actions: ["block","ignore"],
                            src: flow.sh,
                            dst: flow.dh,
                            dhname: flowUtil.dhnameFlow(flow),
                            shname: flow["shname"],
                            mac: flow["mac"],
                            appr: flow["appr"],
                            org: flow["org"],
                            target: flow.lh,
                            fd: flow.fd,
                            du: flow.du,
                            msg: msg
                        };

                      let alarm = new Alarm.VideoAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow), {
                        "p.device.id" : actionobj.shname,
                        "p.device.name" : actionobj.shname,
                        "p.device.ip": flow.sh,
                        "p.dest.name": actionobj.dhname,
                        "p.dest.ip": actionobj.dst
                      });

                      alarmManager2.enrichDeviceInfo(alarm)
                        .then(alarmManager2.enrichDestInfo)
                        .then((alarm) => {
                          alarmManager2.checkAndSave(alarm, (err) => {
                            if(!err) {
                            }
                          });
                        }).catch((err) => {
                          if(err)
                            log.error("Failed to create alarm: " + err);
                        });;

                        alarmManager.alarm(flow.sh, c, 'info', '0', {"msg":msg}, actionobj, (err,obj,action)=> {
                            // if (obj != null) {
                            //     this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                            //                     msg:msg,
                            //                     obj:obj
                            //     });
                            // }
                        });
                    }
                } else if (this.checkIntelClass(flow['intel'],"porn")) {
                  if ((flow.du && Number(flow.du)>20) &&
                      (flow.rb && Number(flow.rb)>1000000) ||
                      this.flowIntelRecordFlow(flow,3)) {

                    // there should be a unique ID between pi and cloud on websites


                        let msg = "Watching porn "+flow["shname"] +" "+flowUtil.dhnameFlow(flow);
                        let actionobj = {
                            title: "Questionable Action",
                            actions: ["block","ignore"],
                            src: flow.sh,
                            dst: flow.dh,
                            dhname: flowUtil.dhnameFlow(flow),
                            shname: flow["shname"],
                            mac: flow["mac"],
                            appr: flow["appr"],
                            org: flow["org"],
                            target: flow.lh,
                            fd: flow.fd,
                            du: flow.du,
                            msg: msg
                        };


                    let alarm = new Alarm.PornAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow), {
                      "p.device.id" : actionobj.shname,
                      "p.device.name" : actionobj.shname,
                      "p.device.ip": flow.sh,
                      "p.dest.name": actionobj.dhname,
                      "p.dest.ip": actionobj.dst
                    });

                    alarmManager2.enrichDeviceInfo(alarm)
                      .then(alarmManager2.enrichDestInfo)
                      .then((alarm) => {
                        alarmManager2.checkAndSave(alarm, (err) => {
                          if(!err) {
                          }
                        })
                      }).catch((err) => {
                        if(err)
                          log.error("Failed to create alarm: " + err);
                      });

                        alarmManager.alarm(flow.sh,c, 'info', '0', {"msg":msg}, actionobj, (err,obj,action)=> {
                            // if (obj!=null) {
                            //       this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                            //            msg:msg,
                            //            obj:obj
                            //       });
                            // }
                        });
                    }
                } else if (this.checkIntelClass(flow['intel'],"intel")) {
                    // Intel object
                    //     {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
    //.indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
                    // ignore partial flows initiated from outside.  They are blocked by firewall and we 
                    // see the packet before that due to how libpcap works

                    if (flowUtil.checkFlag(flow,'s') && flow.fd==="out") {
                       log.info("Intel:On:Partial:Flows", flow,{});
                    } else {
                    let msg = "Intel "+flow["shname"] +" "+flow["dhname"];
                  let intelobj = null;
                    if (flow.fd == "in") {
                        intelobj = {
                            uid: uuid.v4(),
                            ts: flow.ts,
                            fd: flow.fd,
                            "id.orig_h": flow.sh,
                          "id.resp_h": flow.dh,
                          "id.orig_p": flow.sp,
                          "id.resp_p": flow.dp,
                            "seen.indicator_type":"Intel::DOMAIN",
                        };
                        if (flow.intel && flow.intel.action ) {
                            intelobj.action = flow.intel.action;
                        }
                        if (flow.intel && flow.intel.cc) {
                            intelobj.categoryArray = flow.intel.cc;
                        }
                        if (flow.dhname) {
                            intelobj['seen.indicator'] = flow.dhname;
                        } else {
                            intelobj['seen.indicator'] = flow.dh;
                        }
                    } else {
                        intelobj = {
                            uid: uuid.v4(),
                            ts: flow.ts,
                            shname: flow["shname"],
                            dhname: flow["dhname"],
                            mac: flow["mac"],
                            target: flow.lh,
                            fd: flow.fd,
                            appr: flow["appr"],
                            org: flow["org"],
                            "id.orig_h": flow.dh,
                          "id.resp_h": flow.sh,
                          "id.orig_p": flow.dp,
                          "id.resp_p": flow.sp,
                            "seen.indicator_type":"Intel::DOMAIN",
                        };

                        if (flow.intel && flow.intel.action ) {
                            intelobj.action = flow.intel.action;
                        }
                        if (flow.intel && flow.intel.cc) {
                            intelobj.categoryArray = flow.intel.cc;
                        }
                        if (flow.shname) {
                            intelobj['seen.indicator'] = flow.shname;
                        } else {
                            intelobj['seen.indicator'] = flow.sh;
                        }
                    }

                    if (flow.pf) {
                        for (let o in flow.pf) {
                             intelobj['id.resp_p'] = o;
                             break;
                        }
                    }

                    log.info("Intel:Flow Sending Intel", JSON.stringify(intelobj),{});

                    this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.orig_h'], intelobj);
                    this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.resp_h'], intelobj);

                  // Process intel to generate Alarm about it
                  this.processIntelFlow(intelobj);

                    /*
                    this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg
                                        });
                    alarmManager.alarm(flow.sh, "warn", 'major', '50', {"msg":msg}, null, null);
                    */
                  }
                } else if (this.checkIntelClass(flow['intel'],"games") && this.flowIntelRecordFlow(flow,3)) {
                    if ((flow.du && Number(flow.du)>3) && (flow.rb && Number(flow.rb)>30000) || this.flowIntelRecordFlow(flow,3)) {
                        let msg = "Playing "+c+" "+flow["shname"] +" "+flowUtil.dhnameFlow(flow);
                        let actionobj = {
                            title: "Notify Action",
                            actions: ["block","ignore"],
                            src: flow.sh,
                            dst: flow.dh,
                            dhname: flowUtil.dhnameFlow(flow),
                            shname: flow["shname"],
                            mac: flow["mac"],
                            appr: flow["appr"],
                            org: flow["org"],
                            target: flow.lh,
                            fd: flow.fd,
                            du: flow.du,
                            msg: msg
                        };

                      let alarm = new Alarm.GameAlarm(flow.ts, flow["shname"], flowUtil.dhnameFlow(flow), {
                        "p.device.id" : actionobj.shname,
                        "p.device.name" : actionobj.shname,
                        "p.device.ip": flow.sh,
                        "p.dest.name": actionobj.dhname,
                        "p.dest.ip": actionobj.dst
                      });


                      alarmManager2.enrichDeviceInfo(alarm)
                        .then(alarmManager2.enrichDestInfo)
                        .then((alarm) => {
                          alarmManager2.checkAndSave(alarm, (err) => {
                            if(!err) {
                            }
                          });
                        }).catch((err) => {
                          if(err)
                            log.error("Failed to create alarm: " + err);
                        });

                        alarmManager.alarm(flow.sh, c, 'minor', '0', {"msg":msg}, actionobj, (err, obj, action)=>{
                            // if (obj!=null) {
                            //      this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                            //                     msg:msg,
                            //                     obj:obj
                            //      });
                            // }
                        });
                    }
                }
               }
              });
            }
        }
    }

    // summarize will
    // neighbor:<mac>:ip:
    //  {ip: {
    //      ts: ..
    //      count: ...
    //  }
    //  {host: ...}
    // neighbor:<mac>:host:
    //   {set: host}

    //   '17.253.4.125': '{"neighbor":"17.253.4.125","cts":1481438191.098,"ts":1481990573.168,"count":356,"rb":33984,"ob":33504,"du":27.038723000000005,"name":"time-ios.apple.com"}',
    //  '17.249.9.246': '{"neighbor":"17.249.9.246","cts":1481259330.564,"ts":1482050353.467,"count":348,"rb":1816075,"ob":1307870,"du":10285.943863000004,"name":"api-glb-sjc.smoot.apple.com"}',
    summarizeNeighbors(host,flows,direction) {
        let key = "neighbor:"+host.o.mac;
        log.debug("Summarizing Neighbors ",flows.length,key);


        rclient.hgetall(key,(err,data)=> {
             let neighborArray = [];
             if (data == null) {
                 data = {};
             } else {
                 for (let n in data) {
                     data[n] = JSON.parse(data[n]);
                     data[n].neighbor = n;
                     neighborArray.push(data[n]);
                 }
             }
             let now = Date.now()/1000;
             for (let f in flows) {
                 let flow = flows[f];
                 let neighbor = flow.dh;
                 let ob = flow.ob;
                 let rb = flow.rb;
                 let du = flow.du;
                 let name = flow.dhname;
                 if (flow.lh == flow.dh) {
                     neighbor = flow.sh;
                     ob = flow.rb;
                     rb = flow.ob;
                     name = flow.shname;
                 }
                 if (data[neighbor]!=null) {
                     data[neighbor]['ts'] = now;
                     data[neighbor]['count'] +=1;
                     data[neighbor]['rb'] +=rb;
                     data[neighbor]['ob'] +=ob;
                     data[neighbor]['du'] +=du;
                     data[neighbor]['neighbor']=neighbor;
                 } else {
                     data[neighbor] = {};
                     data[neighbor]['neighbor']=neighbor;
                     data[neighbor]['cts'] = now;
                     data[neighbor]['ts'] = now;
                     data[neighbor]['count'] =1;
                     data[neighbor]['rb'] =rb;
                     data[neighbor]['ob'] =ob;
                     data[neighbor]['du'] =du;
                     neighborArray.push(data[neighbor]);
                 }
                 if (name) {
                     data[neighbor]['name'] = name;
                 }
             }
             let savedData = {};

             //chop the minor ones
             neighborArray.sort(function (a, b) {
                return Number(b.count) - Number(a.count);
             })
             let max = 20;

             let deletedArrayCount = neighborArray.slice(max+1);
             let neighborArrayCount = neighborArray.slice(0,max);

             neighborArray.sort(function (a, b) {
                return Number(b.ts) - Number(a.ts);
             })

             let deletedArrayTs = neighborArray.slice(max+1);
             let neighborArrayTs = neighborArray.slice(0,max);

             deletedArrayCount = deletedArrayCount.filter((val)=>{
                 return neighborArrayTs.indexOf(val) == -1;
             });
             deletedArrayTs = deletedArrayTs.filter((val)=>{
                 return neighborArrayCount.indexOf(val) == -1;
             });

             let deletedArray = deletedArrayCount.concat(deletedArrayTs);

             log.debug("Neighbor:Summary:Deleted", deletedArray,{});

             let addedArray = neighborArrayCount.concat(neighborArrayTs);

             log.debug("Neighbor:Summary",key, deletedArray.length, addedArray.length, deletedArrayTs.length, neighborArrayTs.length,deletedArrayCount.length, neighborArrayCount.length);

             for (let i in deletedArray) {
                 rclient.hdel(key,deletedArray[i].neighbor);
             }

             for (let i in addedArray) {
                 // need to delete things not here
                 savedData[addedArray[i].neighbor] = addedArray[i];
             }

             for (let i in savedData) {
                 savedData[i] = JSON.stringify(data[i]);
             }
             rclient.hmset(key,savedData,(err,d)=>{
                 log.debug("Set Host Summary",key,savedData,d);
                 let expiring = fConfig.sensors.OldDataCleanSensor.neighbor.expires || 24*60*60*7;  // seven days
                 rclient.expireat(key, parseInt((+new Date) / 1000) + expiring);
             });
        });
    }

    detect(listip, period,host,callback) {
        let end = Date.now() / 1000;
        let start = end - period; // in seconds
      log.info("Detect",listip);
      flowManager.summarizeConnections(listip, "in", end, start, "time", this.monitorTime/60.0/60.0, true, true, (err, result,activities) => {
            this.flowIntel(result);
            this.summarizeNeighbors(host,result,'in');
            if (activities !=null) {
                /*
                if (host.activities!=null) {
                    if (host.activities.app && host.activities.app.length >0) {
                        host.activities.app = activities.app.concat(host.activities.app);
                    }
                    if (host.activities.activity && host.activities.activity.length >0) {
                        host.activities.activity = activities.activity.concat(host.activities.activity);
                    }
                } else {
                    host.activities = activities;
                }
                host.save("activities",null);
                */
                host.activities = activities;
                host.save("activities",null);
            }
          flowManager.summarizeConnections(listip, "out", end, start, "time", this.monitorTime/60.0/60.0, true, true,(err, result,activities2) => {
                this.flowIntel(result);
                this.summarizeNeighbors(host,result,'out');
                if (callback)
                    callback();
            });
        });
    }


    flows(listip, period,host, callback) {
        // this function wakes up every 15 min and watch past 8 hours... this is the reason start and end is 8 hours appart
        let end = Date.now() / 1000;
        let start = end - this.monitorTime; // in seconds
        flowManager.summarizeConnections(listip, "in", end, start, "time", this.monitorTime/60.0/60.0, true,false, (err, result,activities) => {
            let inSpec = flowManager.getFlowCharacteristics(result, "in", 1000000, stddev_limit);
            if (activities !=null) {
                host.activities = activities;
                host.save("activities",null);
            }
            flowManager.summarizeConnections(listip, "out", end, start, "time", this.monitorTime/60.0/60.0, true,false, (err, resultout) => {
                let outSpec = flowManager.getFlowCharacteristics(resultout, "out", 500000, stddev_limit);
                callback(null, inSpec, outSpec);
            });
        });
    }

    //
    // monitor:flow:ip:<>: <ts score> / { notification }
    //

    // callback doesn't work for now
    // this will callback with each flow that's valid

    saveSpecFlow(direction, ip, flow, callback) {
        let key = "monitor:flow:" + direction + ":" + ip;
        let strdata = JSON.stringify(flow);
        let redisObj = [key, flow.nts, strdata];
        log.debug("monitor:flow:save", redisObj);
        rclient.zadd(redisObj, (err, response) => {
            if (err) {
                log.error("monitor:flow:save", key, err);
            }
            if (callback) {
                callback(err, null);
            }
        });
    }

    processSpec(direction, flows, callback) {
        for (let i in flows) {
            let flow = flows[i];
            flow.rank = i;
            let ip = flow.sh;
            if (direction == 'out') {
                ip = flow.dh;
            }
            let key = "monitor:flow:" + direction + ":" + ip;
            let fullkey = "monitor:flow:" + direction + ":" + flow.sh + ":" + flow.dh;
            log.debug("monitor:flow", key);
            let now = Date.now() / 1000;
            rclient.zrevrangebyscore([key, now, now - 60 * 60 * 8], (err, results) => {
                if (err == null && results.length > 0) {
                    log.debug("monitor:flow:found", results);
                    let found = false;
                    for (let i in results) {
                        let _flow = JSON.parse(results[i]);
                        if (_flow.sh == flow.sh && _flow.dh == flow.dh) {
                            found = true;
                            break;
                        }
                    }
                    if (this.fcache[fullkey] != null) {
                        found = true;
                    }

                    //found = false;

                    if (found == false) {
                        flow.nts = Date.now() / 1000;
                        this.fcache[fullkey] = flow;
                        this.saveSpecFlow(direction, ip, flow, (err) => {
                            callback(null, direction, flow);
                        });
                    } else {
                        log.debug("monitor:flow:duplicated", key);
                    }
                } else if (err == null) {
                    flow.nts = Date.now() / 1000;
                    this.fcache[fullkey] = flow;
                    this.saveSpecFlow(direction, ip, flow, (err) => {
                        callback(null, direction, flow);
                    });
                }
            });
        }
    }

    /* Sample Spec
    Monitor:Flow:In MonitorEvent 192.168.2.225 { direction: 'in',
      txRanked:
       [ { ts: 1466695174.518089,
           sh: '192.168.2.225',
           dh: '52.37.161.188',
           ob: 45449694,
           rb: 22012400,
           ct: 13705,
           fd: 'in',
           lh: '192.168.2.225',
           du: 1176.5127850000029,
           bl: 0,
           shname: 'raspbNetworkScan',
           dhname: 'iot.encipher.io',
           org: '!',
           txratio: 2.0647314241064127 } ],
      rxRanked:
    */

    run(service,period) {
            log.info("FlowMonitor Running Process :", service);
            hostManager.getHosts((err, result) => {
                this.fcache = {}; //temporary cache preventing sending duplicates, while redis is writting to disk
                result = result.filter(x => x) // workaround if host is undefined or null
                async.eachLimit(result,2, (host, cb) => {
                    let listip = [];
                    listip.push(host.o.ipv4Addr);
                    if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                        for (let p in host['ipv6Addr']) {
                            listip.push(host['ipv6Addr'][p]);
                        }
                    }
                    if (service == null || service == "dlp") {
                        log.debug("DLP",listip);
                        this.flows(listip, period,host, (err, inSpec, outSpec) => {
                            log.debug("monitor:flow:", host.toShortString());
                            log.debug("inspec", inSpec);
                            log.debug("outspec", outSpec);
                            if (outSpec) {
                                if ((outSpec.txRanked && outSpec.txRanked.length > 0) ||
                                    (outSpec.rxRanked && outSpec.rxRanked.length > 0) ||
                                    (outSpec.txRatioRanked && outSpec.txRatioRanked.length > 0)) {
                                    this.processSpec("out", outSpec.txRatioRanked, (err, direction, flow) => {
                                        if (flow) {
                                            let copy = JSON.parse(JSON.stringify(flow));
                                            let msg = "Warning: " + flowManager.toStringShortShort2(flow, 'out', 'txdata');
                                            copy.msg = msg;
                                            let actionobj = {
                                                title: "Suspicious Large Upload",
                                                actions: ["block","ignore"],
                                                src: flow.dh,
                                                dst: flow.sh,
                                                target: flow.lh,
                                              //info: ,
                                              //infourl:
                                                msg: msg
                                            }
                                            let remoteHost = flow.dh;
                                            if (flow.lh == flow.dh) {
                                                remoteHost = flow.sh;
                                            }

                                            intelManager._location(remoteHost,(err,loc)=>{
                                                if (loc) {
                                                    copy.lobj = loc;
                                                }

                                                if(fc.isFeatureOn("large_upload")) {
                                                    let alarm = new Alarm.LargeTransferAlarm(flow.ts, flow.dh, flow.shname || flow.sh, {
                                                        "p.device.id" : flow.dhname,
                                                        "p.device.name" : flow.dhname,
                                                        "p.device.ip" : flow.dh,
                                                        "p.device.port" : flow.dp || 0,
                                                        "p.dest.name": flow.shname || flow.sh,
                                                        "p.dest.ip": flow.sh,
                                                        "p.dest.port" : flow.sp,
                                                        "p.transfer.outbound.size" : flow.rb,
                                                        "p.transfer.inbound.size" : flow.ob,
                                                        "p.transfer.duration" : flow.du,
                                                        "p.local_is_client": 0, // connection is initiated from local
                                                        "p.flow": JSON.stringify(flow)
                                                      });
        
                                                      alarmManager2.enrichDestInfo(alarm).then((alarm) => {
                                                        alarmManager2.checkAndSave(alarm, (err) => {
                                                          if(!err) {
                                                          }
                                                        });
                                                      });
        
                                                      alarmManager.alarm(host.o.ipv4Addr, "outflow", 'major', '50', copy, actionobj,(err,data,action)=>{
                                                          // if (data!=null) {
                                                          //   this.publisher.publish("MonitorEvent", "Monitor:Flow:Out", host.o.ipv4Addr, {
                                                          //       direction: "out",
                                                          //       "txRatioRanked": [flow],
                                                          //       id:data.id,
                                                          //   });
                                                          // }
                                                        });
                                                }

                                            });
                                        }
                                    });
                                }
                            }
                            if (inSpec) {
                                if ((inSpec.txRanked && inSpec.txRanked.length > 0) ||
                                    (inSpec.rxRanked && inSpec.rxRanked.length > 0) ||
                                    (inSpec.txRatioRanked && inSpec.txRatioRanked.length > 0)) {
                                    this.processSpec("in", inSpec.txRatioRanked, (err, direction, flow) => {
                                        if (flow) {
                                            let copy = JSON.parse(JSON.stringify(flow));
                                            let msg = "Warning: " + flowManager.toStringShortShort2(flow, 'in', 'txdata');
                                            copy.msg = msg;
                                            let actionobj = {
                                                title: "Suspicious Large Upload",
                                                actions: ["block","ignore"],
                                                src: flow.sh,
                                                dst: flow.dh,
                                                target: flow.lh,
                                                msg: msg
                                            }
                                            let remoteHost = flow.dh;
                                            if (flow.lh == flow.dh) {
                                                remoteHost = flow.sh;
                                            }

                                            intelManager._location(remoteHost,(err,loc)=>{
                                                if (loc) {
                                                    copy.lobj = loc;
                                                }

                                                if(fc.isFeatureOn("large_upload")) {
                                                    // flow in means connection initiated from inside
                                                    // flow out means connection initiated from outside (more dangerous)

                                                    let alarm = new Alarm.LargeTransferAlarm(flow.ts, flow.shname, flow.dhname || flow.dh, {
                                                    "p.device.id" : flow.shname,
                                                    "p.device.name" : flow.shname,
                                                    "p.device.ip" : flow.sh,
                                                    "p.device.port" : flow.sp || 0,
                                                    "p.dest.name": flow.dhname || flow.dh,
                                                    "p.dest.ip": flow.dh,
                                                    "p.dest.port" : flow.dp,
                                                    "p.transfer.outbound.size" : flow.ob,
                                                    "p.transfer.inbound.size" : flow.rb,
                                                    "p.transfer.duration" : flow.du,
                                                    "p.local_is_client": 1, // connection is initiated from local
                                                    "p.flow": JSON.stringify(flow)
                                                    });

                                                    // ideally each destination should have a unique ID, now just use hostname as a workaround
                                                    // so destionationName, destionationHostname, destionationID are the same for now
                                                    alarmManager2.enrichDestInfo(alarm).then((alarm) => {
                                                    alarmManager2.checkAndSave(alarm, (err) => {
                                                        if(!err) {
                                                        }
                                                    });
                                                    });

                                                    alarmManager.alarm(host.o.ipv4Addr, "inflow", 'major', '50', copy, actionobj,(err,data)=>{
                                                        // if (data!=null) {
                                                        //   this.publisher.publish("MonitorEvent", "Monitor:Flow:Out", host.o.ipv4Addr, {
                                                        //       direction: "in",
                                                        //       "txRatioRanked": [flow],
                                                        //       id:data.id,
                                                        //   });
                                                        // }
                                                    });
                                                }

                                            });
                                        }
                                    });
                                }
                            }
                        });
                        cb();
                    } else if (service == "detect") {
                        log.info("Running Detect");
                        this.detect(listip, period, host, (err) => {
                            cb();
                        });
                    }
                }, (err)=> {
                    log.info("FlowMonitor Running Process End :", service);
                    this.garbagecollect();
                });
            });
        }
  // Reslve v6 or v4 address into a local host

  getDeviceIP(obj) {
    if(sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_h'];
    } else {
      return obj['id.resp_h'];
    }
  }

  getRemoteIP(obj) {
    if(!sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_h'];
    } else {
      return obj['id.resp_h'];
    }
  }

  getDevicePort(obj) {
    if(sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_p'];
    } else {
      return obj['id.resp_p'];
    }
  }

  getRemotePort(obj) {
    if(!sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_p'];
    } else {
      return obj['id.resp_p'];
    }
  }

  processPornFlow(flow) {

  }

  processVideoFlow(flow) {

  }

  processGameFlow(flow) {
    //TODO
  }

  processIntelFlow(flowObj) {
    let deviceIP = this.getDeviceIP(flowObj);
    let remoteIP = this.getRemoteIP(flowObj);

    if (sysManager.isLocalIP(remoteIP) == true ||
        sysManager.ignoreIP(remoteIP) == true) {
      log.error("Host:Subscriber:Intel Error related to local ip", remoteIP);
      return;
    }

    // TODO: handle alarm dedup or surpression in AlarmManager2

    dnsManager.resolveRemoteHost(remoteIP, (err, name) => {
      let remoteHostname = name.name || remoteIP;

      intelManager.lookup(remoteIP, (err, iobj, url) => {

        if (err != null || iobj == null) {
          log.error("Host:Subscriber:Intel:NOTVERIFIED",deviceIP, remoteIP);
          return;
        }

        if (iobj.severityscore < 4) {
          log.error("Host:Subscriber:Intel:NOTSCORED", iobj);
          return;
        }

        let severity = iobj.severityscore > 50 ? "major" : "minor";
        let reason = iobj.reason;

        if(fc.isFeatureOn("cyber_security")) {
          let alarm = new Alarm.IntelAlarm(flowObj.ts, deviceIP, severity, {
            "p.device.ip": deviceIP,
            "p.device.port": this.getDevicePort(flowObj),
            "p.dest.id": remoteIP,
            "p.dest.ip": remoteIP,
            "p.dest.name": remoteHostname,
            "p.dest.port": this.getRemotePort(flowObj),
            "p.security.reason": reason,
            "p.security.numOfReportSources": iobj.count,
            "p.local_is_client": (flowObj.fd === 'in' ? 1 : 0)
          });
    
  
          if (flowObj && flowObj.action) {
            alarm["p.action.block"]=flowObj.action.block;
          }
  
          if (flowObj && flowObj.categoryArray) {
            alarm['p.security.category']=flowObj.categoryArray;
          }
  
          log.info("Host:ProcessIntelFlow:Alarm",alarm);
  
          alarmManager2.enrichDeviceInfo(alarm)
            .then(alarmManager2.enrichDestInfo)
            .then((alarm) => {
              alarmManager2.checkAndSave(alarm, (err) => {
                if(err)
                  log.error("Fail to save alarm: " + err);
              });
            }).catch((err) => {
              log.error("Failed to create alarm: " + err);
            });
        }
        
      });
    });
  }
}
