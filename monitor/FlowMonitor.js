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

const rclient = require('../util/redis_manager.js').getRedisClient()

let FlowManager = require('../net2/FlowManager.js');
let flowManager = new FlowManager('info');

let Alarm = require('../alarm/Alarm.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js');
let alarmManager2 = new AlarmManager2();

let audit = require('../util/audit.js');

const fc = require('../net2/config.js')

let uuid = require('uuid');

const HostTool = require('../net2/HostTool')
const hostTool = new HostTool()

let _async = require('async');

const async = require('asyncawait/async');
const await = require('asyncawait/await');


let instance = null;
let HostManager = require("../net2/HostManager.js");
let hostManager = new HostManager("cli", 'client', 'info');

let default_stddev_limit = 8;
let default_inbound_min_length = 1000000;
let deafult_outbound_min_length = 500000;

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

const validator = require('validator');

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

        //   flowManager.last24HourDatabaseExists()
        //     .then((result) => {
        //       if(!result) {
        //         // need to migrate from legacy
        //         log.info("Migrating stats from old version to new version");
        //         hostManager.migrateStats()
        //           .then(() => {
        //             log.info("Stats are migrated to new format");
        //           });
        //       }
        //     });
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

    isFlowIntelInClass(intel, classes) {
      if (!intel || !classes) {
        return false;
      }

      if (!Array.isArray(classes)) {
        classes = [classes];
      }

      const intelFeatureMapping = {
        "av": "video",
        "games": "game",
        "porn": "porn",
        "intel": "cyber_security",
        'spam': "cyber_security",
        'phishing': "cyber_security",
        'piracy': "cyber_security",
        'suspicious': "cyber_security"
      }

      let enabled = classes.map(c => {
        const featureName = intelFeatureMapping[c];
        if (!featureName) {
          return false;
        }
        if (!fc.isFeatureOn(featureName)) {
          log.debug(`Feature ${featureName} is not enabled`);
          return false;
        }
        return true;
      }).reduce((acc, cur) => acc || cur);

      if (!enabled) {
        return false;
      }

      if (classes.includes(intel.category)) {
        return true;
      } else {
          if(classes.includes("intel")) { // for security alarm, category must equal to 'intel'
              return false;
          }
      }

      if (classes.includes(intel.c)) {
        return true;
      }

      function isMatch(_classes, v) {
        let matched;
        try {
          let _v = new Set(Array.isArray(v) ? v : JSON.parse(v));
          matched = _classes.filter(x => _v.has(x)).length > 0;
        } catch (err) {
          log.warn("Error when match classes", _classes, "with value", v, err);
        }
        return matched;
      }

      if (intel.cs && isMatch(classes, intel.cs)) {
        return true;
      }

      if (intel.cc && isMatch(classes, intel.cc)) {
        return true;
      }

      return false;
    }

    flowIntel(flows) {
        for (let i in flows) {
            let flow = flows[i];
            log.debug("FLOW:INTEL:PROCESSING",JSON.stringify(flow),{});
            if (flow.intel && flow.intel.category && !flowUtil.checkFlag(flow,'l')) {
              log.debug("########## flowIntel",JSON.stringify(flow),{});
              let c = flow.intel.category;
              let cs = flow.intel.cs;

              hostManager.isIgnoredIPs([flow.sh,flow.dh,flow.dhname,flow.shname],(err,ignore)=>{
               if (ignore) {
                   log.info("######## flowIntel:Ignored",flow);
                   return;
               }

                log.debug("######## flowIntel Processing",JSON.stringify(flow));
                if (this.isFlowIntelInClass(flow['intel'],"av")) {
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
                        "p.dest.ip": actionobj.dst,
                        "p.dest.port": flow.dp
                      });

                      alarmManager2.enqueueAlarm(alarm);
                    }
                } else if (this.isFlowIntelInClass(flow['intel'],"porn")) {
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
                      "p.dest.ip": actionobj.dst,
                      "p.dest.port": flow.dp
                    });

                    alarmManager2.enqueueAlarm(alarm);
                  }
                } else if (this.isFlowIntelInClass(flow['intel'], ['intel', 'suspicious', 'piracy', 'phishing', 'spam'])) {
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
                    if (flow.fd === "in") {
                        intelobj = {
                          uid: uuid.v4(),
                          ts: flow.ts,
                          fd: flow.fd,
                          intel: flow.intel,
                          "id.orig_h": flow.sh,
                          "id.resp_h": flow.dh,
                          "id.orig_p": flow.sp,
                          "id.resp_p": flow.dp,
                          sp_array: flow.sp_array,
                          "seen.indicator_type": "Intel::DOMAIN",
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
                            intel: flow.intel,
                            appr: flow["appr"],
                            org: flow["org"],
                            "id.orig_h": flow.dh,
                            "id.resp_h": flow.sh,
                            "id.orig_p": flow.dp,
                            "id.resp_p": flow.sp,
                            sp_array: flow.sp_array,
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
                  }
                } else if (this.isFlowIntelInClass(flow['intel'],"games") && this.flowIntelRecordFlow(flow,3)) {
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
                        "p.dest.ip": actionobj.dst,
                        "p.dest.port": flow.dp
                      });


                    alarmManager2.enqueueAlarm(alarm);
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
        //log.info("Detect",listip);
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

          let inbound_min_length = default_inbound_min_length;
          let outbound_min_length = deafult_outbound_min_length;
          let stddev_limit = default_stddev_limit;

          if(fc.isFeatureOn("insane_mode")) {
            inbound_min_length = 1000;
            outbound_min_length = 1000;
            stddev_limit = 1;
          }

          let inSpec = flowManager.getFlowCharacteristics(result, "in", inbound_min_length, stddev_limit);
          if (activities !=null) {
              host.activities = activities;
              host.save("activities",null);
          }
          flowManager.summarizeConnections(listip, "out", end, start, "time", this.monitorTime/60.0/60.0, true,false, (err, resultout) => {
              let outSpec = flowManager.getFlowCharacteristics(resultout, "out", outbound_min_length, stddev_limit);
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

    run(service, period, callback) {
        callback = callback || function() {}
        let runid = new Date()/1000
        log.info("FlowMonitor Running Process :", service, period, runid);
        const startTime = new Date() / 1000
        hostManager.getHosts((err, result) => {
            this.fcache = {}; //temporary cache preventing sending duplicates, while redis is writting to disk
            result = result.filter(x => x) // workaround if host is undefined or null
            _async.eachLimit(result,2, (host, cb) => {
                let listip = [];
                listip.push(host.o.ipv4Addr);
                if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                    for (let p in host['ipv6Addr']) {
                        listip.push(host['ipv6Addr'][p]);
                    }
                }
                if (!service || service === "dlp") {
                    log.debug("DLP",listip);
                    this.flows(listip, period,host, (err, inSpec, outSpec) => {
                        log.debug("monitor:flow:", host.toShortString());
                        log.debug("inspec", inSpec);
                        log.debug("outspec", outSpec);
                      cb();
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

                                    intelManager.ipinfo(remoteHost).then(loc =>{
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

                                          (async () => {
                                            await alarmManager2.checkAndSaveAsync(alarm)
                                          })().catch((err) => {
                                            log.error("Failed to enrich and save alarm", err)
                                          })
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

                                    intelManager.ipinfo(remoteHost).then(loc => {
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
                                            (async () => {
                                              await alarmManager2.checkAndSaveAsync(alarm)
                                            })().catch((err) => {
                                              log.error("Failed to enrich and save alarm", err)
                                            })
                                        }

                                    });
                                }
                            });
                        }
                    }
                });
            } else if (service === "detect") {
                  if(listip.length > 0) {
                    log.info("Running Detect:",listip[0]);
                  }
                this.detect(listip, period, host, (err) => {
                    cb();
                });
            }
        }, (err)=> {
            const endTime = new Date() /1000
            log.info(`FlowMonitor Running Process End with ${Math.floor(endTime - startTime)} seconds :`, service, period, runid);
            this.garbagecollect();
            callback();
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

  getDevicePorts(obj) {
    if(sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['sp_array'];
    } else {
      return [obj['id.resp_p']];
    }
  }

  getRemotePort(obj) {
    if(!sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['id.orig_p'];
    } else {
      return obj['id.resp_p'];
    }
  }

  getRemotePorts(obj) {
    if (!sysManager.isLocalIP(obj['id.orig_h'])) {
      return obj['sp_array'];
    } else {
      return [obj['id.resp_p']];
    }
  }

  processPornFlow(flow) {

  }

  processVideoFlow(flow) {

  }

  processGameFlow(flow) {
    //TODO
  }

  async processIntelFlow(flowObj) {
    log.info("Process intel flow for", flowObj);  
    const deviceIP = this.getDeviceIP(flowObj);
    const remoteIP = this.getRemoteIP(flowObj);

    if (sysManager.isLocalIP(remoteIP) || sysManager.ignoreIP(remoteIP)) {
      log.error("Host:Subscriber:Intel Error related to local ip", remoteIP);
      return;
    }
    
    

    // TODO: handle alarm dedup or surpression in AlarmManager2
    let success;
    try {
      success = await this.checkDomainAlarm(remoteIP, deviceIP, flowObj);
    } catch(err) {
      log.error("Error when check domain alarm", err);
    }

    if (success) {
      log.info("Successfully triggered domain alarm, skip IP alarm triggering");
      return;
    }

    try {
      await this.checkIpAlarm(remoteIP, deviceIP, flowObj);
    } catch(err) {
      log.error("Error when check IP alarm", err);
    }
  }

  async checkDomainAlarm(remoteIP, deviceIP, flowObj) {
    if (!fc.isFeatureOn("cyber_security")) {
      log.info("Feature cyber_security is off, skip...");
      return;
    }

    log.info("Start check domain alarm for:", remoteIP);
    const domain = await hostTool.getName(remoteIP);
    log.info("Domain for IP ", remoteIP, "is", domain);

    let isDomain = false;
    try {
      isDomain = validator.isFQDN(domain);
    } catch (err) {
    }

    if (!isDomain) {
      log.info(`Domain '${domain}' is not a valid domain, skip check alarm:`);
      return;
    }

    let intelObj = null;
    try {
      log.info("Start to lookup intel for domain:", domain);
      intelObj = await intelManager.lookupDomain(domain, remoteIP, flowObj);
      log.info("Finish lookup intel for domain:", domain, "intel is", intelObj);
    } catch (err) {
      log.error("Error when lookup intel for domain:", domain, deviceIP, remoteIP, err);
      return;
    }

    if (!intelObj) {
      log.info("No intel for domain:", domain, deviceIP, remoteIP);
      return;
    }

    if(intelObj.severityscore && Number(intelObj.severityscore) === 0) {
      log.info("Intel ignored, severity score is zero", intelObj);
      return;
    }

    const reasons = []
    let _category, reason = 'Access a ';
    switch (intelObj.category) {
      case 'spam':
      case 'phishing':
      case 'piracy':
      case 'suspicious':
        reasons.push(intelObj.category)
        reason += intelObj.category;
        intelObj.severityscore = 30;
        _category = intelObj.category;
        break;
      case 'intel':
        reasons.push(intelObj.cc)
        reason += intelObj.cc;
        intelObj.severityscore = 70;
        _category = intelObj.cc;
        break;
      default:
        return;
    }

    reason += ' domain or host';
    let severity = intelObj.severityscore > 50 ? "major" : "minor";
    intelObj.reason = reason;
    intelObj.summary = '';
    
    log.info("Domain", domain, "'s intel is", intelObj);
    
    log.info("Start to generate alarm for domain", domain);
    let alarm = new Alarm.IntelAlarm(flowObj.ts, deviceIP, severity, {
      "p.device.ip": deviceIP,
      "p.device.port": this.getDevicePort(flowObj),
      "p.dest.id": remoteIP,
      "p.dest.ip": remoteIP,
      "p.dest.name": domain,
      "p.dest.port": this.getRemotePort(flowObj),
      "p.security.reason": reasons.join(","),
      "p.security.primaryReason": reasons[0],
      "p.security.numOfReportSources": "Firewalla global security intel",
      "p.local_is_client": (flowObj.fd === 'in' ? 1 : 0),
      "p.source": "firewalla_intel",
      "p.severity.score": intelObj.severityscore,
      "r.dest.whois": JSON.stringify(intelObj.whois),
      "e.device.ports": this.getDevicePorts(flowObj),
      "e.dest.ports": this.getRemotePorts(flowObj),
      "p.from": intelObj.from
    });

    if (flowObj && flowObj.action && flowObj.action === "block") {
      alarm["p.action.block"] = true
    }
    
    alarm['p.security.category'] = [_category];
    alarm['p.alarm.trigger'] = 'domain';
    
    if (intelObj.tags) {
      alarm['p.security.tags'] = intelObj.tags;
    }

    log.info(`Cyber alarm for domain '${domain}' has been generated`, alarm);

    try {
      await alarmManager2.checkAndSaveAsync(alarm);
    } catch (err) {
      if (err.code === 'ERR_DUP_ALARM' || err.code === 'ERR_BLOCKED_BY_POLICY_ALREADY') {
        log.warn("Duplicated alarm exists or blocking policy already there, skip firing new alarm");
        return true; // in this case, ip alarm no need to trigger either
      }
      log.error("Error when save alarm:", err.message);
      return;
    }

    return true;
  }
  
  async checkIpAlarm(remoteIP, deviceIP, flowObj) {
    log.info("Check IP Alarm for traffic from: ", deviceIP, ", to:", remoteIP);
    const domain = await hostTool.getName(remoteIP);

    let iobj;
    try {
      iobj = await intelManager.lookupIp(remoteIP, flowObj.intel);
    } catch (err) {
      log.error("Host:Subscriber:Intel:NOTVERIFIED", deviceIP, remoteIP);
      return;
    }

    if (iobj.severityscore < 4) {
      log.error("Host:Subscriber:Intel:NOTSCORED", iobj);
      return;
    }

    let severity = iobj.severityscore > 50 ? "major" : "minor";
    let reason = iobj.reason;

    if (!fc.isFeatureOn("cyber_security")) {
      return;
    }

    let alarm = new Alarm.IntelAlarm(flowObj.ts, deviceIP, severity, {
      "p.device.ip": deviceIP,
      "p.device.port": this.getDevicePort(flowObj),
      "p.dest.id": remoteIP,
      "p.dest.ip": remoteIP,
      "p.dest.name": domain || remoteIP,
      "p.dest.port": this.getRemotePort(flowObj),
      "p.security.reason": reason,
      "p.security.numOfReportSources": iobj.count,
      "p.local_is_client": (flowObj.fd === 'in' ? 1 : 0),
//      "p.dest.whois": JSON.stringify(iobj.whois),
      "p.severity.score": iobj.severityscore,
      "p.from": iobj.from,
      "e.device.ports": this.getDevicePorts(flowObj),
      "e.dest.ports": this.getRemotePorts(flowObj)
    });

    if (flowObj && flowObj.action && flowObj.action === "block") {
      alarm["p.action.block"] = true
    }

    if (flowObj && flowObj.categoryArray) {
      alarm['p.security.category'] = flowObj.categoryArray;
    }

    if (iobj.tags) {
      alarm['p.security.tags'] = iobj.tags;
    }

    alarm['p.alarm.trigger'] = 'ip';

    log.info("Host:ProcessIntelFlow:Alarm", alarm);

    alarmManager2.checkAndSaveAsync(alarm)
    .then(() => {
      log.info(`Alarm ${alarm.aid} is created successfully`);
    }).catch((err) => {
      if(err) {
        log.error("Failed to create alarm: ", err);
      }
    });
  };
  
}
