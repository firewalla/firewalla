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
var ip = require('ip');
var os = require('os');
var network = require('network');
var stats = require('stats-lite');

var redis = require("redis");
var rclient = redis.createClient();

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');
var DNSManager = require('./DNSManager.js');
var dnsManager = new DNSManager('info');
var bone = require("../lib/Bone.js");
var firewalla = require("../net2/Firewalla.js");

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');
var flowUtil = require('../net2/FlowUtil.js');
var instance = null;

var maxflow = 10000;

var bconfig;
// Will use bconfig.config.flow.activitymin/activitymax
var flowconfig = {
    activityDetectMin : 10,
    activityDetectMax : 60*60*5,
}; 

class FlowGraph {
    constructor(name,flowarray) {
         if (flowarray) {
             this.flowarray = flowarray;
         } else {
             this.flowarray = [];
         }
         this.name = name;
         firewalla.getBoneInfo((err,config)=>{
             bconfig = config;
             if (bconfig.config.flow && bconfig.config.flow.activityDetectMin) {
                 flowconfig = bconfig.config.flowManager;
             }
         });
    }


    flowarraySorted(recent) {
        if (recent == true) {
             this.flowarray.sort(function (a, b) {
                 return Number(b[1]) - Number(a[1]);
             })
             return this.flowarray;
        } else {
             this.flowarray.sort(function (a, b) {
                 return Number(a[1]) - Number(b[1]);
             })
             return this.flowarray;
        }
    }


    addFlow(flow) {
         if (flow.flows == null) {
             let flowStart = Math.ceil(Number(flow.__ts) - Number(flow.du));
             let flowEnd = Math.ceil(Number(flow.__ts));
             if (flow.__ts==null) {
                 flowStart = Math.ceil(Number(flow._ts) - Number(flow.du));
                 flowEnd = Math.ceil(Number(flow._ts));
             }
             let ob = Number(flow.ob);
             let rb = Number(flow.rb);
                
             this.addRawFlow(flowStart,flowEnd,ob,rb,flow.ct);
         } else {
             //console.log("$$$ before ",flow.flows);
             for (let i in flow.flows) {
                 let f = flow.flows[i];
                 this.addRawFlow(f[0],f[1],f[2],f[3],1);
             }
             //console.log("$$$ after",this.flowarray);
         }
    }

    addRawFlow(flowStart, flowEnd, ob,rb,ct) {
         let insertindex = 0;

         for (let i in this.flowarray) {
             let e = this.flowarray[i];
             if (flowStart < e[0]) {
                 break;
             }
             if (flowStart<e[1]) {
                 flowStart = e[0];
                 break;
             }
             insertindex = Number(i)+Number(1);
         }

         let removed = Number(0);
         for (let i = insertindex; i <this.flowarray.length;i++) {
             let e = this.flowarray[Number(i)];
             if (e[1]<flowEnd) {
                 ob += e[2];
                 rb += e[3];
                 ct += e[4];
                 removed++;
                 continue;
             } else if (e[1]>=flowEnd) {
                 ob += e[2];
                 rb += e[3];
                 ct += e[4];
                 flowEnd = e[1];
                 removed++;
                 break;
             }
         }

         this.flowarray.splice(insertindex,removed, [flowStart,flowEnd, ob,rb,ct]);
    //     console.log("insertindex",insertindex,"removed",removed,this.flowarray,"<=end");

    }

}

module.exports = class FlowManager {
    constructor(loglevel) {
        if (instance == null) {
            let cache = {};
            instance = this;
            log = require("./logger.js")("FlowManager", loglevel);
        }
        return instance;
    }

    // stats are 'hour', 'day'
    // stats:hour:ip_address score=bytes key=_ts-_ts%3600
    // ip = 0.0.0.0 is system
    recordStats(ip,type,ts,inBytes,outBytes,callback) {
        let period = 3600;
        if (type === "day") {
            period = 60*60*24;
        } else if (type ==="month") {
            period = 60*60*24*30;
        }
        let inkey = "stats:"+type+":in:"+ip;
        let outkey = "stats:"+type+":out:"+ip;
        let subkey = ts-ts%period;

        if (inBytes == null || outBytes == null) {
            return;
        }
 
        rclient.zincrby(inkey,Number(inBytes),subkey,(err,data)=>{
            rclient.zincrby(outkey,Number(outBytes),subkey,(err,data)=>{
                if (callback) {
                    callback(err);
                } 
            }); 
        }); 
    }

    getStats(iplist,type,from,to,callback) {
        let outdb = {};
        let indb = {};
        let inbytes = 0;
        let outbytes = 0;
        let lotsofkeys = 24*30*6;  //half months ... of data 
        console.log("Getting stats:",type,iplist,from,to);
        async.eachLimit(iplist, 1, (ip, cb) => {
            let inkey = "stats:"+type+":in:"+ip;
            let outkey = "stats:"+type+":out:"+ip;
            rclient.zscan(inkey,0,'count',lotsofkeys,(err,data)=>{
                //console.log("Data:",data);
                if (data && data.length==2) {
                    let array = data[1];
                    console.log("array:",array.length);
                    for (let i=0;i<array.length;i++) {
                        let clock = Number(array[i]);
                        let bytes = Number(array[i+1]);
                        i++;
                        if (clock<Number(from)) {
                            continue;
                        }
                        if (Number(to)!=-1 &&  clock>to) {
                            continue;
                        }
                        
                        if (indb[clock]) {
                            indb[clock] += Number(bytes);
                        } else {
                            indb[clock] = Number(bytes);
                        }
                        inbytes+=Number(bytes);
                    }
                } 
                rclient.zscan(outkey,0,'count',lotsofkeys,(err,data)=>{
                    if (data && data.length==2) {
                        let array = data[1];
                        for (let i=0;i<array.length;i++) {
                            let clock = Number(array[i]);
                            let bytes = Number(array[i+1]);
                            i++;
                            if (clock<Number(from)) {
                                continue;
                            }
                            if (Number(to)!=-1 &&  clock>to) {
                                continue;
                            }
                            if (outdb[clock]) {
                                outdb[clock] += Number(bytes);
                            } else {
                                outdb[clock] = Number(bytes);
                            }
                            outbytes+=Number(bytes);
                        }
                    }
                    cb();
                });
            });
        }, (err)=>{
            let tsnow = Math.ceil(Date.now()/1000);
            tsnow = tsnow-tsnow%3600;
            let flowdata = {tophour:tsnow, from:from, to:to,type:type, flowinbytes:[], flowoutbytes:[],inbytes:inbytes,outbytes:outbytes};

            let keys = Object.keys(outdb); // or loop over the object to get the array
            keys.sort().reverse(); // maybe use custom sort, to change direction use .reverse()
            for (let i=0; i<keys.length; i++) { // now lets iterate in sort order
               let key = keys[i];
               flowdata.flowoutbytes.push({size:outdb[key],ts:keys[i]});
            }  
            keys = Object.keys(indb); // or loop over the object to get the array
            keys.sort().reverse(); // maybe use custom sort, to change direction use .reverse()
            for (let i=0; i<keys.length; i++) { // now lets iterate in sort order
               let key = keys[i];
               flowdata.flowinbytes.push({size:indb[key],ts:keys[i]});
            }  
            //console.log("FLOW DATA IS: ",flowdata,outdb,indb);
            callback(err, flowdata);
        });
    }

    // 
    // {
    //    mostflow: { flow:, std:}
    //    leastflow: { flow:,std:}
    //    total:
    // }   
    // 
    // tx here means to outside
    // rx means inside
    getFlowCharacteristics(_flows, direction, minlength, sdv) {
        log.info("====== Calculating Flow spec of flows", _flows.length, direction, minlength, sdv);
        if (minlength == null) {
            minlength = 500000;
        }
        if (sdv == null) {
            sdv = 4;
        }
        if (_flows.length <= 0) {
            return null;
        }

        let flowspec = {};
        let flows = [];
        flowspec.direction = direction;
        flowspec.txRanked = [];
        flowspec.rxRanked = [];
        flowspec.txRatioRanked = [];

        let txratios = [];
        let rxvalues = [];
        let txvalues = [];
        let shostSummary = {};
        let dhostSummary = {};
        for (let i in _flows) {
            let flow = _flows[i];
            if (flow.rb < minlength && flow.ob < minlength) {
                continue;
            }
            flows.push(flow);

            if (flow.fd == "in") {
                txvalues.push(flow.ob);
            } else if (flow.fd == "out") {
                txvalues.push(flow.rb);
            }
            if (flow.fd == "in") {
                rxvalues.push(flow.rb);
            } else if (flow.fd == "out") {
                rxvalues.push(flow.ob);
            }
            let shost = shostSummary[flow.sh];
            let dhost = dhostSummary[flow.dh];
            if (shost) {
                shost.ob += flow.ob;
                shost.rb += flow.rb;
            } else {
                shostSummary[flow.sh] = {
                    ob: flow.ob,
                    rb: flow.rb
                };
            }
            if (dhost) {
                dhost.ob += flow.ob;
                dhost.rb += flow.rb;
            } else {
                dhostSummary[flow.dh] = {
                    ob: flow.ob,
                    rb: flow.rb
                };
            }

            if (flow.fd == "in") {
                flow.txratio = flow.ob / flow.rb;
                if (flow.rb == 0) {
                    flow.txratio = Math.min(flow.ob, 10);
                }
            } else if (flow.fd == "out") {
                flow.txratio = flow.rb / flow.ob;
                if (flow.ob == 0) {
                    flow.txratio = Math.min(flow.rb);
                }
            } else {
                log.error("FlowManager:FlowSummary:Error", flow);
            }
            txratios.push(flow.txratio);
        }


        if (flows.length <= 1) {
            // Need to take care of this condition
            log.info("FlowManager:FlowSummary", "not enough flows");
            if (flows.length == 1) {
                flowspec.rxRanked.push(flows[0]);
                flowspec.txRanked.push(flows[0]);
                if (flows[0].txratio > 1.5) {
                    flowspec.txRatioRanked.push(flows[0]);
                }
                flowspec.onlyflow = true;
            }
            return flowspec;
        }

        flowspec.txStdev = stats.stdev(txvalues);
        flowspec.rxStdev = stats.stdev(rxvalues);
        flowspec.txratioStdev = stats.stdev(txratios)

        if (flowspec.txStdev == 0) {
            flowspec.txStdev = 1;
        }
        if (flowspec.rxStdev == 0) {
            flowspec.rxStdev = 1;
        }
        if (flowspec.txratioStdev == 0) {
            flowspec.txratioStdev = 1;
        }

        log.debug("txStd Deviation", flowspec.txStdev);
        log.debug("rxStd Deviation", flowspec.rxStdev);
        log.debug("txRatioStd Deviation", flowspec.txratioStdev);
        for (let i in flows) {
            let flow = flows[i];
            if (flow.fd == "in") {
                flow['rxStdev'] = flow.rb / flowspec.rxStdev;
                flow['txStdev'] = flow.ob / flowspec.txStdev;
                flow['txratioStdev'] = flow.txratio / flowspec.txratioStdev;
            } else if (flow.fd == "out") {
                flow['rxStdev'] = flow.ob / flowspec.txStdev;
                flow['txStdev'] = flow.rb / flowspec.rxStdev;
                flow['txratioStdev'] = flow.txratio / flowspec.txratioStdev;
            }
        }

        flows.sort(function (a, b) {
            return Number(b['rxStdev']) - Number(a['rxStdev']);
        })
        let max = 5;
        log.debug("RX ");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.rxStdev < sdv) {
                continue;
            }
            log.debug(flow,{});
            flowspec.rxRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }
        flows.sort(function (a, b) {
            return Number(b['txStdev']) - Number(a['txStdev']);
        })
        max = 5;
        log.debug("TX ");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.txStdev < sdv) {
                continue;
            }
            log.debug(flow,{});
            flowspec.txRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }
        flows.sort(function (a, b) {
            return Number(b['txratioStdev']) - Number(a['txratioStdev']);
        })
        max = 5;
        log.debug("TX Ratio");
        for (let i in flows) {
            let flow = flows[i];
            if (flow.txratioStdev < sdv || flow.txratio < 1) {
                continue;
            }
            log.debug(flow,{});
            flowspec.txRatioRanked.push(flow);
            max--;
            if (max < 0) {
                break;
            }
        }

        return flowspec;

        //     console.log("ShostSummary", shostSummary, "DhostSummary", dhostSummary);

    }

    /* given a list of flows, break them down to conversations
     *  
     * produce a summary of flows like
     *   {::flow:: + duration } ...
     */
    getAppSummary(flow, callback) {

    }

    summarizeHostBytes(host,from,to,block,callback) {
            let listip = []
            listip.push(host.o.ipv4Addr);
            if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                for (let j in host['ipv6Addr']) {
                    listip.push(host['ipv6Addr'][j]);
                }
            }
            host.flowsummary = {};
            host.flowsummary.inbytes = 0;
            host.flowsummary.outbytes = 0;
            this.getStats(listip,block,from,to,callback);
    }

    summarizeBytes2(hosts,from,to,block,callback) {
        async.eachLimit(hosts, 1, (host, cb) => {
            this.summarizeHostBytes(host,from,to,block,(err,data)=>{
                host.flowsummary = data;
                cb();
            });
        },(err) => {
            callback(null,null);
        });
    }

    // block is in seconds
    // deprecated 
/*
    summarizeBytes(hosts, from, to, block, callback) {
        let sys = {};
        sys.inbytes = 0;
        sys.outbytes = 0;
        sys.flowinbytes = [];
        sys.flowoutbytes = [];
        async.eachLimit(hosts, 5, (host, cb) => {
            let listip = []
            listip.push(host.o.ipv4Addr);
            if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                for (let j in host['ipv6Addr']) {
                    listip.push(host['ipv6Addr'][j]);
                }
            }
            host.flowsummary = {};
            host.flowsummary.inbytes = 0;
            host.flowsummary.outbytes = 0;
            let flows = [];
            async.eachLimit(listip, 5, (ip, cb2) => {
                let key = "flow:conn:" + "in" + ":" + ip;
                rclient.zrevrangebyscore([key, from, to,'withscores','limit',0,maxflow], (err, result) => {
                    log.info("SummarizeBytes:",key,from,to,result.length);
                    host.flowsummary.inbytesArray = [];
                    host.flowsummary.outbytesArray = [];
                    if (err == null) {
                        for (let i=0;i<result.length;i++) {
                            let o = JSON.parse(result[i]);
                            if (o == null) {
                                log.error("Host:Flows:Sorting:Parsing", result[i]);
                                i++;
                                continue;
                            }
                            o._ts = Number(result[i+1]); 
                            if (o._ts<to) {
                                i++;
                                continue;
                            }  
                            i++;
                            sys.inbytes += o.rb;
                            sys.outbytes += o.ob;
                            host.flowsummary.inbytes += o.rb;
                            host.flowsummary.outbytes += o.ob;
                            flows.push(o);
                        }
                    }
                    let okey = "flow:conn:" + "out" + ":" + ip;
                    rclient.zrevrangebyscore([okey, from, to,'withscores','limit',0,maxflow], (err, result) => {
                        if (err == null) {
                            for (let i=0;i<result.length;i++) {
                                let o = JSON.parse(result[i]);
                                if (o == null) {
                                    log.error("Host:Flows:Sorting:Parsing", result[i]);
                                    i++;
                                    continue;
                                }
                                o._ts = Number(result[i+1]);
                                if (o._ts<to) {
                                    i++;
                                    continue;
                                }
                                i++;
                                sys.inbytes += o.ob;
                                sys.outbytes += o.rb;
                                host.flowsummary.inbytes += o.ob;
                                host.flowsummary.outbytes += o.rb;
                                flows.push(o);
                            }
                        }
                        cb2();
                    });
                });
            }, (err) => {
                //  break flows down in to blocks
                let btime = from - block;
                let flowinbytes = [];
                let flowoutbytes = [];
                let currentFlowin = 0;
                let currentFlowout = 0;

                flows.sort(function (a, b) {
                    return Number(b._ts) - Number(a._ts);
                })
                for (let i in flows) {
                    let flow = flows[i];
                    if (flow._ts > btime) {
                        if (flow.fd == "in") {
                            currentFlowin += flow.rb;
                            currentFlowout += flow.ob;
                        } else {
                            currentFlowin += flow.ob;
                            currentFlowout += flow.rb;
                        }
                    } else {
                        flowinbytes.push({
                            ts: btime,
                            size: currentFlowin
                        });
                        flowoutbytes.push({
                            ts: btime,
                            size: currentFlowout
                        });
                        let j = flowinbytes.length - 1;
                        if (sys.flowinbytes[j]) {
                            sys.flowinbytes[j].size += currentFlowin;
                        } else {
                            sys.flowinbytes[j] = {
                                ts: btime,
                                size: currentFlowin
                            };
                        }
                        if (sys.flowoutbytes[j]) {
                            sys.flowoutbytes[j].size += currentFlowout;
                        } else {
                            sys.flowoutbytes[j] = {
                                ts: btime,
                                size: currentFlowout
                            };
                        }
                        btime = btime - block;
                        currentFlowin = 0;
                        currentFlowout = 0;
                    }
                }
                host.flowsummary.flowinbytes = flowinbytes;
                host.flowsummary.flowoutbytes = flowoutbytes;

                cb();
            });
        }, (err) => {
            console.log(sys);
            callback(err, sys);
        });
    }
*/

    summarizeActivityFromConnections(flows,callback) {
        let appdb = {};
        let activitydb = {};

        for (let i in flows) {
            let flow = flows[i];
            if (flow.du<flowconfig.activityDetectMin) {
                continue;
            }
            if (flow.du>flowconfig.activityDetectMax) {
                continue;
            }
            if (flow.flows) {
                 let fg = new FlowGraph("raw");
                 //console.log("$$$ Before",flow.flows);
                 for (let i in flow.flows) {
                       let f = flow.flows[i];
                       let count = f[4];
                       if (count ==null) {
                           count =1;
                       }
                       fg.addRawFlow(f[0],f[1],f[2],f[3],count);
                 }
                 flow.flows = fg.flowarray;
                 //console.log("$$$ After",flow.flows);
            }
            if (flow.appr) {
                if (appdb[flow.appr]) {
                    appdb[flow.appr].push(flow);
                } else {
                    appdb[flow.appr] = [flow];
                }
            } else if (flow.intel && flow.intel.c && flow.intel.c!="intel") {
                if (activitydb[flow.intel.c]) {
                    activitydb[flow.intel.c].push(flow);
                } else {
                    activitydb[flow.intel.c] = [flow];
                }
            }
        }

/*
        console.log("--------------appsdb ---- ");
        console.log(appdb);
        console.log("--------------activitydb---- ");
        console.log(activitydb);
*/
        //console.log(activitydb);
 
        let flowobj = {id:0,app:{},activity:{}};
        let hasFlows = false;

        for (let i in appdb) {
            let f = new FlowGraph(i);
            for (let j in appdb[i]) {
                f.addFlow(appdb[i][j]);
                hasFlows = true;
            }
            flowobj.app[f.name]= f.flowarraySorted(true);
            for (let k in flowobj.app[f.name]) {
                let _f = flowobj.app[f.name][k];
            }
        }
        for (let i in activitydb) {
            let f = new FlowGraph(i);
            for (let j in activitydb[i]) {
                f.addFlow(activitydb[i][j]);
                hasFlows = true;
            }
            flowobj.activity[f.name]=f.flowarraySorted(true);;
            for (let k in flowobj.activity[f.name]) {
                let _f = flowobj.activity[f.name][k];
            }
         
        }
        // linear these flows
       
        if (!hasFlows) {
            if (callback) {
                callback(null,null);
            }
            return;
        }

        //console.log("### Cleaning",flowobj);

        bone.flowgraph("clean", [flowobj],(err,data)=>{
            if (callback) {
                callback(err,data);
            }
        });
    }

    summarizeConnections(ipList, direction, from, to, sortby, hours, resolve, saveStats, callback) {
        let sorted = [];
        async.each(ipList, (ip, cb) => {
            let key = "flow:conn:" + direction + ":" + ip;
            rclient.zrevrangebyscore([key, from, to,"LIMIT",0,maxflow], (err, result) => {
                let conndb = {};
                let interval = 0;
                let totalInBytes = 0;
                let totalOutBytes = 0;
                if (err == null) {
                    if (result!=null && result.length>0) 
                        log.info("### Flow:Summarize",key,direction,from,to,sortby,hours,resolve,saveStats,result.length);
                    for (let i in result) {
                        let o = JSON.parse(result[i]);
                        if (o == null) {
                            log.error("Host:Flows:Sorting:Parsing", result[i]);
                            continue;
                        }
                        if (o.rb == null || o.ob == null) {
                            continue;
                        }
                        if (o.rb == 0 && o.ob ==0) {
                            // ignore zero length flows
                            continue;
                        }
                        if (saveStats) {
                            if (direction == 'in') {
                                totalInBytes+=Number(o.rb);
                                totalOutBytes+=Number(o.ob);
                                this.recordStats(ip,"hour",o.ts,Number(o.rb),Number(o.ob),null);
                            } else {
                                totalInBytes+=Number(o.ob);
                                totalOutBytes+=Number(o.rb);
                                this.recordStats(ip,"hour",o.ts,Number(o.ob),Number(o.rb),null);
                            }
                        }
                        let ts = o.ts;
                        if (o._ts) {
                            ts = o._ts;
                        }
                        if (interval == 0 || ts < interval) {
                            if (interval == 0) {
                                interval = Date.now() / 1000;
                            }
                            interval = interval - hours * 60 * 60;
                            for (let j in conndb) {
                                sorted.push(conndb[j]);
                            }
                            conndb = {};
                        }
                        let key = "";
                        if (o.sh == ip) {
                            key = o.dh + ":" + o.fd;
                        } else {
                            key = o.sh + ":" + o.fd;
                        }
                        //     let key = o.sh+":"+o.dh+":"+o.fd;
                        let flow = conndb[key];
                        if (flow == null) {
                            conndb[key] = o;
                        } else {
                            flow.rb += o.rb;
                            flow.ct += o.ct;
                            flow.ob += o.ob;
                            flow.du += o.du;
                            if (flow.ts < o.ts) {
                                flow.ts = o.ts;
                            }
                            if (o.pf) {
                                for (let k in o.pf) {
                                    if (flow.pf[k] != null) {
                                        flow.pf[k].rb += o.pf[k].rb;
                                        flow.pf[k].ob += o.pf[k].ob;
                                        flow.pf[k].ct += o.pf[k].ct;
                                    } else {
                                        flow.pf[k] = o.pf[k]
                                    }
                                }
                            }
                            if (o.flows) {
                                if (flow.flows) {
                                    flow.flows = flow.flows.concat(o.flows);
                                } else {
                                    flow.flows = o.flows;
                                }
                            }
                        }

                    }

                    if (saveStats) {
                        let _ts = Math.ceil(Date.now() / 1000);
                        this.recordStats("0.0.0.0","hour",_ts,totalInBytes,totalOutBytes,null);
                    }

                    for (let m in conndb) {
                        sorted.push(conndb[m]);
                    }
                    if (result.length>0) 
                        log.info("### Flow:Summarize",key,direction,from,to,sortby,hours,resolve,saveStats,result.length,totalInBytes,totalOutBytes);
                    conndb = {};
                    cb();
                } else {
                    log.error("Unable to search software");
                    cb();
                }
            });
        }, (err) => {
            if (err) {
                log.error("Flow Manager Error");
                callback(null, sorted);
            } else {
                log.info("============ Host:Flows:Sorted", sorted.length);
                if (sortby == "time") {
                    sorted.sort(function (a, b) {
                        return Number(b.ts) - Number(a.ts);
                    })
                } else if (sortby == "rxdata") {
                    sorted.sort(function (a, b) {
                        return Number(b.rb) - Number(a.rb);
                    })
                } else if (sortby == "txdata") {
                    sorted.sort(function (a, b) {
                        return Number(b.ob) - Number(a.ob);
                    })
                }

                if (resolve == true) {
                    log.debug("flows:sorted Query dns manager");
                    dnsManager.query(sorted, "sh", "dh", (err) => {
                        if (err != null) {
                            log.error("flow:conn unable to map dns", err);
                        }
                        log.debug("flows:sorted Query dns manager returnes");
                        this.summarizeActivityFromConnections(sorted,(err,activities)=>{
                            //console.log("Activities",activities);
                            let _sorted = [];
                            for (let i in sorted) {
                                if (flowUtil.checkFlag(sorted[i],'x')) {
                                    //console.log("DroppingFlow",sorted[i]); 
                                } else {
                                    _sorted.push(sorted[i]);
                                }
                            }
                            callback(null, _sorted,activities);
                        });
                    });;
                } else {
                    callback(null, sorted);
                }
            }
        });
    }

    toStringShort(obj) {
        //  // "{\"ts\":1464328076.816846,\"sh\":\"192.168.2.192\",\"dh\":\"224.0.0.251\",\"ob\":672001,\"rb\":0,\"ct\":1,\"fd\":\"in\",\"lh\":\"192.168.2.192\",\"bl\":3600}"
        let ts = Date.now() / 1000;
        let t = ts - obj.ts
        t = (t / 60).toFixed(1);
        let _ts = Date.now() / 1000;
        let _t = _ts - obj._ts
        _t = (_t / 60).toFixed(1);
        let org = "";
        if (obj.org) {
            org = "(" + obj.org + ")";
        }
        let appr = "";
        if (obj.appr) {
            appr = "#" + obj.appr + "#";
        }
        return t+"("+_t+")" + "\t" + obj.du + "\t" + obj.sh + "\t" + obj.dh + "\t" + obj.ob + "\t" + obj.rb + "\t" + obj.ct + "\t" + obj.shname + "\t" + obj.dhname + org + appr;
    }

    toStringShortShort2(obj, type, interest) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (type == 'txdata' || type =='out') {
            if (obj.appr && obj.appr.length > 2) {
                name = obj.appr;
            } else if (obj.dhname && obj.dhname.length > 2) {
                name = obj.dhname;
            }
        } else {
            if (obj.appr && obj.appr.length > 2) {
                name = obj.appr;
            } else if (obj.org && obj.org.length > 2) {
                name = obj.org;
            } else if (obj.dhname && obj.dhname.length > 2) {
                name = obj.dhname;
            }
        }

        //let time = Math.round((Date.now() / 1000 - obj.ts) / 60);
        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);
        let dtime = "";

        if (time>5) {
            dtime = time+" min ago, ";
        }

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata" || type == "in") {
            if (interest == 'txdata') {
                return dtime+sname + " transferred to " + name + " [" + obj.ob + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
            }
            return dtime+sname + " transferred to " + name + " " + obj.ob + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
        } else if (type == "txdata" || type == "out") {
            if (interest == 'txdata') {
                return dtime+sname + " transferred to " + name + " : [" + obj.rb + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
            }
            return dtime+sname + " transferred to " + name + ", " + obj.rb + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
        }
    }

    toStringShortShort(obj, type) {
        let sname = obj.sh;
        if (obj.shname) {
            sname = obj.shname;
        }
        let name = obj.dh;
        if (obj.appr && obj.appr.length > 2) {
            name = obj.appr;
        } else if (obj.org && obj.org.length > 2) {
            name = obj.org;
        } else if (obj.dhname && obj.dhname.length > 2) {
            name = obj.dhname;
        }

        let time = Math.round((Date.now() / 1000 - obj.ts) / 60);

        if (type == null) {
            return name + "min : rx " + obj.rb + ", tx " + obj.ob;
        } else if (type == "rxdata") {
            return time + "min: " + sname + "->" + name + " " + obj.rb + " bytes";
        } else if (type == "txdata") {
            return time + "min: " + sname + "->" + name + " : " + obj.ob + " bytes";
        }
    }

    sort(sorted, sortby) {
        if (sortby == "time") {
            sorted.sort(function (a, b) {
                return Number(b.ts) - Number(a.ts);
            })
        } else if (sortby == "rxdata") {
            sorted.sort(function (a, b) {
                return Number(b.rb) - Number(a.rb);
            })
        } else if (sortby == "txdata") {
            sorted.sort(function (a, b) {
                return Number(b.ob) - Number(a.ob);
            })
        } else if (sortby == "duration") {
            sorted.sort(function (a, b) {
                return Number(b.du) - Number(a.du);
            })
        }
        return sorted;
    }

}
