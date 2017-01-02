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
var os = require('os');
var network = require('network');

var redis = require("redis");
var rclient = redis.createClient();

var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('info');

var uuid = require('uuid');

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');
var instance = null;
var HostManager = require("../net2/HostManager.js");
var hostManager = new HostManager("cli", 'client', 'info');

var stddev_limit = 8;
var AlarmManager = require('../net2/AlarmManager.js');
var alarmManager = new AlarmManager('debug');

var IntelManager = require('../net2/IntelManager.js');
var intelManager = new IntelManager('debug');

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
            record.count += 1;
        } else {
            record = {}
            record.ts = Date.now()/1000;
            record.count = 1;
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


    flowIntel(flows) {
        for (let i in flows) {
            let flow = flows[i];
            log.info("FLOW:INTEL:PROCESSING",JSON.stringify(flow),{});
            if (flow['intel'] && flow['intel']['c']) {
              log.info("########## flowIntel",JSON.stringify(flow),{});
              let c = flow['intel']['c'];

              hostManager.isIgnoredIPs([flow.sh,flow.dh,flow.dhname,flow.shname],(err,ignore)=>{
               if (ignore == true) {
                   log.info("######## flowIntel:Ignored",flow);
               }
              
               if (ignore == false) {
                log.info("######## flowIntel Processing",flow);
                if (c == "av") {
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
                            msg: msg
                        };
                        alarmManager.alarm(flow.sh, c, 'info', '0', {"msg":msg}, actionobj, (err,obj,action)=> {
                            if (obj != null) {
                                this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                                msg:msg,
                                                obj:obj
                                });
                            }
                        });
                    }
                } else if (c=="porn") {
                    if ((flow.du && Number(flow.du)>60) && (flow.rb && Number(flow.rb)>3000000) || this.flowIntelRecordFlow(flow,3)) {
                        let msg = "Watching Porn "+flow["shname"] +" "+flowUtil.dhnameFlow(flow);
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
                            msg: msg
                        };
                        alarmManager.alarm(flow.sh,c, 'info', '0', {"msg":msg}, actionobj, (err,obj,action)=> {
                            if (obj!=null) {
                                  this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                       msg:msg,
                                       obj:obj
                                  });
                            }
                        });
                    }
                } else if (c=="intel") {
                    // Intel object
                    //     {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
    //.indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
                    let msg = "Intel "+flow["shname"] +" "+flow["dhname"];
                    let intelobj = null;
                    if (flow.fd == "in") {
                        intelobj = {
                            uid: uuid.v4(),
                            ts: flow.ts,
                            "id.orig_h": flow.sh,
                            "id.resp_h": flow.dh,
                            "seen.indicator_type":"Intel::DOMAIN", 
                        };
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
                            "seen.indicator_type":"Intel::DOMAIN", 
                        };
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

                    log.debug("Intel:Flow Sending Intel", intelobj);
                  
                    this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.orig_h'], intelobj);
                    this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.resp_h'], intelobj);

                    /*
                    this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg
                                        });
                    alarmManager.alarm(flow.sh, "warn", 'major', '50', {"msg":msg}, null, null);
                    */
                } else if (c=="games" && this.flowIntelRecordFlow(flow,3)) {
                    let msg = "Doing "+c+" "+flow["shname"] +" "+flowUtil.dhnameFlow(flow);
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
                        msg: msg
                    };
                    alarmManager.alarm(flow.sh, c, 'minor', '0', {"msg":msg}, actionobj, (err, obj, action)=>{
                        if (obj!=null) {
                             this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg,
                                            obj:obj
                             });
                        }
                    });
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
            hostManager.getHosts((err, result) => {
                this.fcache = {}; //temporary cache preventing sending duplicates, while redis is writting to disk
                for (let j in result) {
                    let host = result[j];
                    let listip = [];
                    listip.push(host.o.ipv4Addr);
                    if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                        for (let p in host['ipv6Addr']) {
                            listip.push(host['ipv6Addr'][p]);
                        }
                    }
                    if (service == null || service == "dlp") {
                        log.info("DLP",listip);
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
                                                alarmManager.alarm(host.o.ipv4Addr, "outflow", 'major', '50', copy, actionobj,(err,data,action)=>{
                                                  if (data!=null) {
                                                    this.publisher.publish("MonitorEvent", "Monitor:Flow:Out", host.o.ipv4Addr, {
                                                        direction: "out",
                                                        "txRatioRanked": [flow],
                                                        id:data.id,
                                                    });
                                                  }
                                                });
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
                                                alarmManager.alarm(host.o.ipv4Addr, "inflow", 'major', '50', copy, actionobj,(err,data)=>{
                                                  if (data!=null) {
                                                    this.publisher.publish("MonitorEvent", "Monitor:Flow:Out", host.o.ipv4Addr, {
                                                        direction: "in",
                                                        "txRatioRanked": [flow],
                                                        id:data.id,
                                                    });
                                                  }
                                                });
                                            });
                                        }
                                    });
                                }
                            }
                        });
                    } else if (service == "detect") {
                        log.info("Running Detect");
                        this.detect(listip, period, host, (err) => {
                        });
                    }
                }
            });
        }
        // Reslve v6 or v4 address into a local host
}
