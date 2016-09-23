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

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');
var instance = null;

var maxflow = 10000;

module.exports = class FlowManager {
    constructor(loglevel) {
        if (instance == null) {
            let cache = {};
            instance = this;
            log = require("./logger.js")("FlowManager", loglevel);
        }
        return instance;
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

    // block is in seconds
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
                rclient.zrevrangebyscore([key, from, to,'limit',0,maxflow], (err, result) => {
                    log.info("SummarizeBytes:",key,from,to,result.length);
                    host.flowsummary.inbytesArray = [];
                    host.flowsummary.outbytesArray = [];
                    if (err == null) {
                        for (let i in result) {
                            let o = JSON.parse(result[i]);
                            if (o == null) {
                                log.error("Host:Flows:Sorting:Parsing", result[i]);
                                continue;
                            }
                            if (o.ts<to) {
                                continue;
                            }
                            sys.inbytes += o.rb;
                            sys.outbytes += o.ob;
                            host.flowsummary.inbytes += o.rb;
                            host.flowsummary.outbytes += o.ob;
                            flows.push(o);
                        }
                    }
                    let okey = "flow:conn:" + "out" + ":" + ip;
                    rclient.zrevrangebyscore([okey, from, to,'limit',0,maxflow], (err, result) => {
                        if (err == null) {
                            for (let i in result) {
                                let o = JSON.parse(result[i]);
                                if (o == null) {
                                    log.error("Host:Flows:Sorting:Parsing", result[i]);
                                    continue;
                                }
                                if (o.ts<to) {
                                    continue;
                                }
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
                    return Number(b.ts) - Number(a.ts);
                })
                for (let i in flows) {
                    let flow = flows[i];
                    if (flow.ts > btime) {
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

    summarizeConnections(ipList, direction, from, to, sortby, hours, resolve, callback) {
        let sorted = [];
        let conndb = {};
        async.each(ipList, (ip, cb) => {
            let key = "flow:conn:" + direction + ":" + ip;
            rclient.zrevrangebyscore([key, from, to,"limit",0,maxflow], (err, result) => {
                //log.debug("Flow:Summarize",key,from,to,hours,result.length);
                let interval = 0;

                if (err == null) {
                    // group together
                    for (let i in result) {
                        let o = JSON.parse(result[i]);
                        if (o == null) {
                            log.error("Host:Flows:Sorting:Parsing", result[i]);
                            continue;
                        }
                        if (o.rb == 0 && o.ob ==0) {
                            // ignore zero length flows
                            continue;
                        }
                        let ts = o.ts;
                        if (interval == 0 || o.ts < interval) {
                            if (interval == 0) {
                                interval = Date.now() / 1000;
                            }
                            interval = interval - hours * 60 * 60;
                            for (let i in conndb) {
                                sorted.push(conndb[i]);
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
                                for (let i in o.pf) {
                                    if (flow.pf[i] != null) {
                                        flow.pf[i].rb += o.pf[i].rb;
                                        flow.pf[i].ob += o.pf[i].ob;
                                        flow.pf[i].ct += o.pf[i].ct;
                                    } else {
                                        flow.pf[i] = o.pf[i]
                                    }
                                }
                            }
                        }
                    }

                    for (let i in conndb) {
                        sorted.push(conndb[i]);
                    }
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
                log.debug("============ Host:Flows:Sorted", sorted.length);
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
                        callback(null, sorted);
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
        let org = "";
        if (obj.org) {
            org = "(" + obj.org + ")";
        }
        let appr = "";
        if (obj.appr) {
            appr = "#" + obj.appr + "#";
        }
        return t + "\t" + obj.du + "\t" + obj.sh + "\t" + obj.dh + "\t" + obj.ob + "\t" + obj.rb + "\t" + obj.ct + "\t" + obj.shname + "\t" + obj.dhname + org + appr;
    }

    toStringShortShort2(obj, type, interest) {
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
        } else if (type == "rxdata" || type == "in") {
            if (interest == 'txdata') {
                return sname + " transfered to " + name + " [" + obj.ob + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.rb + type;
            }
            return sname + " transfered to " + name + " " + obj.ob + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.rb + type;
        } else if (type == "txdata" || type == "out") {
            if (interest == 'txdata') {
                return sname + " transfered to " + name + " : [" + obj.rb + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.ob + type;
            }
            return sname + " transfered to " + name + " : " + obj.rb + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min. debug: " + obj.ob + type;
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
