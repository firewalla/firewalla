/*    Copyright 2016-2024 Firewalla Inc.
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
const stats = require('stats-lite');

const rclient = require('../util/redis_manager.js').getRedisClient()
const fc = require('../net2/config.js')
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager('info');
const bone = require("../lib/Bone.js");

var instance = null;

const QUERY_MAX_FLOW = 10000;

const flowTool = require('./FlowTool');

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const _ = require('lodash');

class FlowGraph {
  constructor(name, flowarray) {
    if (flowarray) {
      this.flowarray = flowarray;
    } else {
      this.flowarray = [];
    }
    this.name = name;
  }


  flowarraySorted(recent) {
    if (recent == true) {
      // sort by end timestamp in descending order
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
      this.addRawFlow(Number(flow.ts), Number(flow.ts+flow.du), Number(flow.ob), Number(flow.rb), flow.ct);
    } else {
      //log.info("$$$ before ",flow.flows);
      for (let i in flow.flows) {
        let f = flow.flows[i];
        this.addRawFlow(f[0], f[1], f[2], f[3], 1);
      }
      //log.info("$$$ after",this.flowarray);
    }
  }

  addRawFlow(flowStart, flowEnd, ob, rb, ct) {
    let insertindex = 0;

    for (let i in this.flowarray) {
      let e = this.flowarray[i];
      if (flowStart < e[0]) {
        break;
      }
      if (flowStart < e[1]) {
        flowStart = e[0];
        break;
      }
      insertindex = Number(i) + Number(1);
    }

    let removed = Number(0);
    for (let i = insertindex; i < this.flowarray.length; i++) {
      let e = this.flowarray[Number(i)];
      if (e[1] < flowEnd) {
        ob += e[2];
        rb += e[3];
        ct += e[4];
        removed++;
        continue;
      } else if (e[1] >= flowEnd) {
        if (e[0] <= flowEnd) {
          // [flowStart, flowEnd] has overlap with [e[0], e[1]]
          ob += e[2];
          rb += e[3];
          ct += e[4];
          flowEnd = e[1];
          removed++;
        }
        break;
      }
    }

    this.flowarray.splice(insertindex, removed, [flowStart, flowEnd, ob, rb, ct]);
    //     log.info("insertindex",insertindex,"removed",removed,this.flowarray,"<=end");
  }

}

module.exports = class FlowManager {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  sumFlows(flows) {
    let result = {};

    if (flows.length === 0) {
      return result;
    }

    let flow1 = flows[0];

    if (!flow1)
      return result;

    Object.keys(flow1).map((k) => {
      let sum = flows.reduce((total, flow) => {
        if (flow[k] && !isNaN(parseInt(flow[k]))) {
          return total + parseInt(flow[k]);
        } else {
          return total;
        }
      }, 0);
      result[k] = sum;
    });

    return result;
  }

  // calculates standard score for bytes uploaded and upload/download ratio
  // tx: transmit, outbound
  // rx: receive, inbound
  getFlowCharacteristics(_flows, direction, profile) {
    log.debug(`====== Calculating Flow spec of ${_flows.length} ${direction} flows: ${JSON.stringify(profile)}`)

    if (!_flows.length) {
      return null;
    }

    let flowspec = {};
    let flows = [];
    flowspec.direction = direction;
    flowspec.txRanked = [];
    flowspec.rxRanked = [];
    flowspec.ratioRanked = [];

    const values = { tx: [], rx: [], ratio: [] }
    const inbound = direction == 'out'

    for (let flow of _flows) {
      flow.tx = inbound ? flow.rb : flow.ob
      flow.rx = inbound ? flow.ob : flow.rb

      flows.push(flow);

      values.tx.push(flow.tx)
      // values.rx.push(flow.rx)
      if (flow.rx) {
        flow.ratio = flow.tx / flow.rx
        values.ratio.push(flow.ratio)
      }
    }

    if (flows.length <= 1) {
      // Need to take care of this condition
      if (flows.length == 1
        && flows[0].tx > (inbound ? profile.txInMin : profile.txOutMin)
        && flows[0].ratio > profile.ratioSingleDestMin
      ) {
        log.debug("FlowManager:FlowSummary single destination", flows[0]);
        flowspec.ratioRanked.push(flows[0]);
      }
      return flowspec;
    }

    // download bytes alone is ignored here
    // save top 5 results to 'Ranked' array
    [/* 'rx', */ 'tx', 'ratio'].forEach(category => {
      const cStdev = `${category}Stdev`;
      const cMean = `${category}Mean`;
      const cStdScore = `${category}StdScore`;
      const cRanked = `${category}Ranked`;

      flowspec[cStdev] = stats.stdev(values[category])
      if (flowspec[cStdev] == 0) return //all same value

      log.debug(`${category} Std Deviation ${flowspec[cStdev]}`);

      flowspec[cMean] = stats.mean(values[category])

      for (let flow of flows) {
        // flow[cStdScore] = flow[category] / flowspec[cStdScore];
        flow[cStdScore] = (flow[category] - flowspec[cMean]) / flowspec[cStdev]
      }

      flows.sort(function (a, b) {
        return Number(b[cStdScore]) - Number(a[cStdScore]);
      })
      log.debug(category, flows.map(f=>f[cStdScore]));

      // negative scores (values < standard deviation) are ignored here
      flowspec[cRanked] = flows
        .filter(f => category == 'tx' && f[cStdScore] > profile.sdMin || category == 'ratio' && f.ratio > profile.ratioMin)
        .slice(0, profile.rankedMax)
        .filter(f => f.tx > (inbound ? profile.txInMin : profile.txOutMin))

      flowspec[cRanked].length && log.debug(category, flowspec[cRanked]);

      // for debug
      flowspec[cRanked].forEach(f => {
        f[cStdev] = flowspec[cStdev]
        f[cMean] = flowspec[cMean]
      })
    })

    return flowspec;
  }

  // this function is no longer used
  async summarizeActivityFromConnections(flows) {
    let appdb = {};
    let activitydb = {};

    const config = fc.getConfig()
    for (let i in flows) {
      let flow = flows[i];
      if (flow.du < config.monitor && config.monitor.activityDetectMin || 10) {
        continue;
      }
      if (flow.du > config.monitor && config.monitor.activityDetectMax || 18000) {
        continue;
      }
      if (flow.appr) {
        if (appdb[flow.appr]) {
          appdb[flow.appr].push(flow);
        } else {
          appdb[flow.appr] = [flow];
        }
      } else if (flow.intel && flow.intel.category && flow.intel.category != "intel") {
        if (activitydb[flow.intel.category]) {
          activitydb[flow.intel.category].push(flow);
        } else {
          activitydb[flow.intel.category] = [flow];
        }
      }
    }

    log.debug('summarizeActivityFromConnections:appdb', appdb);
    log.debug('summarizeActivityFromConnections:activitydb', activitydb);

    let flowobj = { id: 0, app: {}, activity: {} };
    let hasFlows = false;

    for (let i in appdb) {
      let f = new FlowGraph(i);
      for (let j in appdb[i]) {
        f.addFlow(appdb[i][j]);
        hasFlows = true;
      }
      // f.name is i, which is the name of app
      flowobj.app[f.name] = f.flowarraySorted(true);
    }
    for (let i in activitydb) {
      let f = new FlowGraph(i);
      for (let j in activitydb[i]) {
        f.addFlow(activitydb[i][j]);
        hasFlows = true;
      }
      flowobj.activity[f.name] = f.flowarraySorted(true);
    }
    // linear these flows

    if (!hasFlows) {
      return null;
    }

    log.debug("summarizeActivityFromConnections:flowobj",flowobj);

    return bone.flowgraphAsync('clean', [flowobj])
  }


  isFlowValid(flow) {
    let o = flow;

    if (o == null) {
      log.error("Host:Flows:Sorting:Parsing", flow);
      return false;
    }
    if (o.rb == null || o.ob == null) {
      return false
    }
    if (o.rb == 0 && o.ob == 0) {
      // ignore zero length flows
      return false;
    }

    return true;
  }

  // Following check was originally implemented in DNSManager.js
  // moves here as it's way less misleading
  // removes tcp check as BroDetect checks zeek conn_state now
  isAggregatedFlowValid(flow) {
    const o = flow;

    // valid if the category is intel
    if (o.category === 'intel') {
      return true
    }
    if (o.intel && o.intel.category === 'intel') {
      return true
    }

    if (o.fd == "in") {
      if (o.du < 0.0001) {
        return false
      }
      if (o.ob == 0 && o.rb < 1000) {
        return false
      }
      if (o.rb && o.rb < 1500) { // used to be 2500
        return false
      }
    }

    return true
  }

  // aggregates traffic between the same hosts together
  async summarizeConnections(mac, direction, end, start) {
    let sorted = [];
    try {
      const key = "flow:conn:" + direction + ":" + mac;
      const result = await rclient.zrevrangebyscoreAsync([key, end, start, "LIMIT", 0, QUERY_MAX_FLOW]);
      let conndb = {};

      if (result != null && result.length > 0)
        log.debug("### Flow:Summarize", key, direction, end, start, result.length);
      for (let i in result) {
        const o = JSON.parse(result[i]);

        if (!this.isFlowValid(o))
          continue;

        o.mac = mac

        const key = o.sh == o.lh ? o.dh : o.sh

        const flow = conndb[key];
        if (!flow) {
          conndb[key] = o;
          if (_.isObject(o.af) && !_.isEmpty(o.af)) {
            conndb[key].appHosts = Object.keys(o.af);
          }
        } else {
          flow.rb += o.rb;
          flow.ct += o.ct;
          flow.ob += o.ob;

          // flow.ts and flow.du should present the time span of all flows
          if (flow.ts + flow.du < o.ts + o.du) {
            flow.du = o.ts + o.du - flow.ts;
          }
          if (flow.ts > o.ts) {
            flow.ts = o.ts;
            flow.du = flow.ts + flow.du - o.ts;
          }

          flow.sp = _.union(flow.sp, o.sp)
          flow.uids = _.union(flow.uids, o.uids)

          if (_.isObject(o.af) && !_.isEmpty(o.af)) {
            if (flow.appHosts) {
              flow.appHosts = _.uniq(flow.appHosts.concat(Object.keys(o.af)));
            } else {
              flow.appHosts = Object.keys(o.af);
            }
          }
        }
      }

      for (let m in conndb) {
        sorted.push(conndb[m]);
      }

      // trim to reduce size
      sorted.forEach(flowTool.trimFlow);

      conndb = {};
    } catch (err) {
      log.error("Error summarizing connections", err);
      return {
        connections: sorted
      };
    }
    // log.debug("============ Host:Flows:Sorted", mac, sorted.length);
    sorted.sort(function (a, b) {
      return Number(b.ts) - Number(a.ts);
    })

    await this.enrichHttpFlowsInfo(sorted);

    await dnsManager.query(sorted, "sh", "dh", "mac", "appHosts")
      .catch(err => log.error("flow:conn unable to map dns", err))

    const _sorted = sorted.filter(this.isAggregatedFlowValid)

    return {
      connections: _sorted
    };
  }

  async enrichHttpFlowsInfo(flows) {
    if (_.isEmpty(flows)) {
      return;
    }

    for (const flow of flows) {
      let urls = await this._findRelatedHttpFlows(flow);
      urls = urls.filter((url, index) => urls.indexOf(url) === index);

      let intels = [];

      for (const url of urls) {
        const intel = await intelTool.getURLIntel(url);
        if (intel) {
          intel.url = url;
          intels.push(intel);
        }
      }

      if (!_.isEmpty(intels)) {
        flow.urls = intels;
      }
    }
  }

  async _findRelatedHttpFlows(flow) {
    if (!flow || !flow.uids) {
      return;
    }

    const urls = [];

    for (const uid of flow.uids) {
      const key = `flowgraph:${uid}`;
      const fg = await rclient.hgetallAsync(key);

      if (!fg) {
        continue; // no related urls
      }

      if (!fg.http) {
        continue; // no related urls
      }

      if (!fg.mac || !fg.flowDirection) {
        log.error(`Invalid flowgraph: ${fg}`);
        continue;
      }

      const httpFlowKey = `flow:http:${fg.flowDirection}:${fg.mac}`;

      const httpFlows = await rclient.zrangebyscoreAsync(httpFlowKey, fg.http, fg.http);

      for (const httpFlowJSON of httpFlows) {
        try {
          const httpFlow = JSON.parse(httpFlowJSON);
          if (httpFlow.uid === uid && httpFlow.uri && httpFlow.host) {
            const url = `${httpFlow.host}${httpFlow.uri}`;
            urls.push(url);
          }
        } catch (err) {
          log.error(`Failed to parse http flow json ${httpFlowJSON} from key ${httpFlowKey}, ts: ${fg.ts}, err: ${err}`);
        }
      }
    }

    return urls;
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
    return t + "(" + _t + ")" + "\t" + obj.du + "\t" + obj.sh + "\t" + obj.dh + "\t" + obj.ob + "\t" + obj.rb + "\t" + obj.ct + "\t" + obj.shname + "\t" + obj.dhname + org + appr;
  }

  toStringShortShort2(obj, type, interest) {
    let sname = obj.sh;
    if (obj.shname) {
      sname = obj.shname;
    }
    let name = obj.dh;
    if (type == 'txdata' || type == 'out') {
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

    if (time > 5) {
      dtime = time + " min ago, ";
    }

    if (type == null) {
      return name + "min : rx " + obj.rb + ", tx " + obj.ob;
    } else if (type == "rxdata" || type == "in") {
      if (interest == 'txdata') {
        return dtime + sname + " transferred to " + name + " [" + obj.ob + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
      }
      return dtime + sname + " transferred to " + name + " " + obj.ob + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
    } else if (type == "txdata" || type == "out") {
      if (interest == 'txdata') {
        return dtime + sname + " transferred to " + name + " : [" + obj.rb + "] bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
      }
      return dtime + sname + " transferred to " + name + ", " + obj.rb + " bytes" + " for the duration of " + Math.round(obj.du / 60) + " min.";
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

  async removeFlowsAll(mac) {
    // flow:http & flow:ssl & stats:day & stats:month seem to be deprecated

    let keys = [
      'flow:conn:in:' + mac,
      'flow:conn:out:' + mac,
      'audit:drop:' + mac,
      'audit:accept:' + mac
    ];

    await rclient.unlinkAsync(keys);
    return;
  }
}
