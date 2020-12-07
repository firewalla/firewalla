/*    Copyright 2016-2020 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient()

const util = require('util');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const DestIPFoundHook = require('../hook/DestIPFoundHook');
const destIPFoundHook = new DestIPFoundHook();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const MAX_RECENT_INTERVAL = 24 * 60 * 60; // one day
const MAX_RECENT_FLOW = 100;

const Promise = require('bluebird');

const _ = require('lodash');

let instance = null;
class FlowTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  trimFlow(flow) {
    if(!flow)
      return;

    if("flows" in flow)
      delete flow.flows;

    if("pf" in flow)
      delete flow.pf;

    if("af" in flow)
      delete flow.af;

//    if("f" in flow)
//      delete flow.f;
    if("uids_array" in flow) {
      flow.uids = flow.uids_array.filter((v, i) => {
        return flow.uids_array.indexOf(v) === i;
      });
      delete flow.uids_array;
    }
  }

  _mergeFlow(targetFlow, flow) {
    targetFlow.download += flow.download;
    targetFlow.upload += flow.upload;
    targetFlow.duration += flow.duration;
    if (targetFlow.ts < flow.ts) { // ts had been converted to the _ts: update/record time
      targetFlow.ts = flow.ts;
    }
  }
  _shouldMerge(targetFlow, flow) {
    const compareKeys = ['device', 'ip', 'fd', 'port', 'protocol'];
    return _.isEqual(_.pick(targetFlow, compareKeys), _.pick(flow, compareKeys));
  }

  _flowStringToJSON(flow) {
    try {
      return JSON.parse(flow);
    } catch(err) {
      return null;
    }
  }

  _isFlowValid(flow) {
    let o = flow;

    if (!o) {
      log.error("Host:Flows:Sorting:Parsing", flow);
      return false;
    }
    if ( !('rb' in o) || !('ob' in o) ) {
      return false
    }
    if (o.rb === 0 && o.ob === 0) {
      // ignore zero length flows
      return false;
    }
    if (o.f === "s") {
      // short packet flag, maybe caused by arp spoof leaking, ignore these packets
      return false;
    }

    return true;
  }


  _enrichCountryInfo(flow) {
    let sh = flow.sh;
    let dh = flow.dh;
    let lh = flow.lh;

    if (sh === lh) {
      flow.country = intelTool.getCountry(dh)
    } else {
      flow.country = intelTool.getCountry(sh)
    }
  }

  async prepareRecentFlows(json, options) {
    options = options || {}
    if (!options.count || options.count > MAX_RECENT_FLOW) options.count = MAX_RECENT_FLOW
    if (!options.asc) options.asc = false;

    if (!("flows" in json)) {
      json.flows = {};
    }
    let recentFlows = [];
    if (options.direction) {
      recentFlows = options.direction == 'in' ?
        (options.mac ? await this.getRecentIncomingConnections(options.mac, options) : await this.getAllRecentIncomingConnections(options))
        : (options.mac ? await this.getRecentOutgoingConnections(options.mac, options) : await this.getAllRecentOutgoingConnections(options))
    } else {
      let outgoing, incoming;
      if (options.mac) {
        outgoing = await this.getRecentOutgoingConnections(options.mac, options);
        incoming = await this.getRecentIncomingConnections(options.mac, options);
      } else { // intf, tag, and default
        outgoing = await this.getAllRecentOutgoingConnections(options)
        incoming = await this.getAllRecentIncomingConnections(options)
      }
      recentFlows = [].concat(outgoing,incoming);
    }
    recentFlows = _.orderBy(recentFlows, 'ts', options.asc ? 'asc' : 'desc');
    if(!options.no_merge) {
      recentFlows = this._mergeFlows(recentFlows);
    }

    json.flows.recent = recentFlows.slice(0, options.count);

    return recentFlows
  }

  _mergeFlows(flowObjects) {
    let mergedFlowObjects = [];
    let lastFlowObject = null;

    flowObjects.forEach((flowObject) => {
      if(!lastFlowObject) {
        mergedFlowObjects.push(flowObject);
        lastFlowObject = flowObject;
        return;
      }

      if (this._shouldMerge(lastFlowObject, flowObject)) {
        this._mergeFlow(lastFlowObject, flowObject);
      } else {
        mergedFlowObjects.push(flowObject);
        lastFlowObject = flowObject;
      }
    });

    return mergedFlowObjects;
  }

  // convert flow json to a simplified json format that's more readable by app
  toSimpleFlow(flow) {
    let f = {};
    f.ts = flow._ts; // _ts:update/record time, front-end always show up this
    f.fd = flow.fd;
    f.duration = flow.du
    f.intf = flow.intf;
    f.tags = flow.tags;

    if(flow.mac) {
      f.device = flow.mac;
    }

    f.protocol = flow.pr;

    try {
      if(flow.lh === flow.sh) {
        f.port = Number(flow.dp);
        f.devicePort = Number(flow.sp[0]);
      } else {
        f.port = Number(flow.sp[0]);
        f.devicePort = Number(flow.dp);
      }
    } catch(err) {
    }

    if(flow.lh === flow.sh) {
      f.ip = flow.dh;
      f.deviceIP = flow.sh;
      f.upload = flow.ob;
      f.download = flow.rb;
    } else {
      f.ip = flow.sh;
      f.deviceIP = flow.dh;
      f.upload = flow.rb;
      f.download = flow.ob;
    }

    return f;
  }

  getRecentOutgoingConnections(target, options) {
    return this.getRecentConnections(target, "in", options)
  }

  getRecentIncomingConnections(target, options) {
    return this.getRecentConnections(target, "out", options);
  }


  getAllRecentOutgoingConnections(options) {
    return this.getAllRecentConnections("in", options)
  }

  getAllRecentIncomingConnections(options) {
    return this.getAllRecentConnections("out", options);
  }

  // this is to get all recent connections in the network
  // regardless which device it belongs to
  async getAllRecentConnections(direction, options) {
    options = options || {}

    let allMacs = [];
    if (options.intf) {
      if (!_.isArray(options.macs) || options.macs.length === 0) {
        const HostManager = require("../net2/HostManager.js");
        const hostManager = new HostManager();
        allMacs = hostManager.getIntfMacs(options.intf);
      } else {
        allMacs = options.macs;
      }
    } else if (options.tag) {
      const HostManager = require("../net2/HostManager.js");
      const hostManager = new HostManager();
      allMacs = hostManager.getTagMacs(options.tag);
    } else {
      allMacs = await hostTool.getAllMACs();
      if (_.isArray(options.macs))
        allMacs = allMacs.concat(options.macs);
    }

    const allFlows = [];

    await Promise.all(allMacs.map(async mac => {
      const optionsCopy = JSON.parse(JSON.stringify(options)) // get a clone to avoid side impact to other functions

      const flows = await this.getRecentConnections(mac, direction, optionsCopy);

      flows.forEach(flow => {
        flow.device = mac
      });

      allFlows.push.apply(allFlows, flows);
    }));

    return allFlows;
  }

  _aggregateTransferBy10Min(results) {
    const aggrResults = {};
    results.forEach((x) => {
      const ts = x.ts;
      const tenminTS = Math.floor(Number(ts) / 600) * 600;
      if(!aggrResults[tenminTS]) {
        aggrResults[tenminTS] = {
          ts: tenminTS,
          ob: x.ob,
          rb: x.rb
        }
      } else {
        const old = aggrResults[tenminTS];
        aggrResults[tenminTS] = {
          ts: tenminTS,
          ob: x.ob + old.ob,
          rb: x.rb + old.rb
        }
      }
    })
    return Object.values(aggrResults).sort((x,y) => {
      if(x.ts > y.ts) {
        return 1;
      } else if(x.ts === y.ts) {
        return 0;
      } else {
        return -1;
      }
    });
  }

  async _getTransferTrend(target, destinationIP, options) {
    options = options || {};
    const end = options.end || Math.floor(new Date() / 1000);
    const begin = options.begin || end - 3600 * 6; // 6 hours
    const direction = options.direction || 'in';

    const key = util.format("flow:conn:%s:%s", direction, target);

    const results = await rclient.zrangebyscoreAsync([key, begin, end]);

    if(results === null || results.length === 0) {
      return [];
    }

    const list = results
    .map((jsonString) => {
      try {
        return JSON.parse(jsonString);
      } catch(err) {
        log.error(`Failed to parse json string: ${jsonString}, err: ${err}`);
        return null;
      }
    })
    .filter((x) => x !== null)
    .filter((x) => x.sh === destinationIP || x.dh === destinationIP)
    .map((x) => {
      return {
        ts: x.ts,
        ob: x.sh === destinationIP ? x.rb : x.ob, // ob stands for number of bytes transferred from local to remote, regardless of flow direction
        rb: x.sh === destinationIP ? x.ob : x.rb  // rb strands for number of bytes transferred from remote to local, regardless of flow direction
      }
    })

    return list;
  }

  async getTransferTrend(deviceMAC, destinationIP, options) {
    options = options || {};

    const transfers = [];

    if (!options.direction || options.direction === "in") {
      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.direction = "in";
      const t_in = await this._getTransferTrend(deviceMAC, destinationIP, optionsCopy);
      transfers.push.apply(transfers, t_in);
    }

    if (!options.direction || options.direction === "out") {
      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.direction = "out";
      const t_out = await this._getTransferTrend(deviceMAC, destinationIP, optionsCopy);
      transfers.push.apply(transfers, t_out);
    }
    return this._aggregateTransferBy10Min(transfers);
  }

  async enrichWithIntel(flows) {
    return await Promise.map(flows, async f => {
      // get intel from redis. if failed, create a new one
      const intel = await intelTool.getIntel(f.ip);

      if (intel) {
        f.country = intel.country;
        f.host = intel.host;
        if(intel.category) {
          f.category = intel.category
        }
        if(intel.app) {
          f.app = intel.app
        }
      }

      // failed on previous cloud request, try again
      if (intel && intel.cloudFailed || !intel) {
        // not waiting as that will be too slow for API call
        destIPFoundHook.processIP(f.ip);
      }

      return f;
    }, {concurrency: 10}); // limit to 10
  }

  async getRecentConnections(target, direction, options) {
    options = options || {};
    if (!options.count || options.count > MAX_RECENT_FLOW) options.count = MAX_RECENT_FLOW

    const key = util.format("flow:conn:%s:%s", direction, target);
    let ts, ets;

    if (!options.ts) {
      ts = (options.asc ? options.begin : options.end) || new Date() / 1000;
      ets = options.asc ? (options.end || ts + MAX_RECENT_INTERVAL) : (options.begin || ts - MAX_RECENT_INTERVAL)
    } else {
      ts = options.ts
      ets = options.asc ? ts + MAX_RECENT_INTERVAL : ts - MAX_RECENT_INTERVAL
    }

    const zrange = (options.asc ? rclient.zrangebyscoreAsync : rclient.zrevrangebyscoreAsync).bind(rclient);
    let results = await zrange(key, '(' + ts, ets, "LIMIT", 0 , options.count);

    if(results === null || results.length === 0)
      return [];

    let flowObjects = results
      .map((x) => this._flowStringToJSON(x))
      .filter((x) => this._isFlowValid(x));

    flowObjects.forEach((x) => {
      this.trimFlow(x)
    });

    let simpleFlows = flowObjects
      .map((f) => {
        let s = this.toSimpleFlow(f)
        s.device = target; // record the mac address here
        return s;
      });

    let enrichedFlows = await this.enrichWithIntel(simpleFlows);

    return enrichedFlows
  }

  getFlowKey(mac, type) {
    return util.format("flow:conn:%s:%s", type, mac);
  }

  addFlow(mac, type, flow) {
    let key = this.getFlowKey(mac, type);

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return rclient.zaddAsync(key, flow.ts, JSON.stringify(flow));
  }

  removeFlow(mac, type, flow) {
    let key = this.getFlowKey(mac, type);

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return rclient.zremAsync(key, JSON.stringify(flow))
  }

  async flowExists(mac, type, flow) {
    let key = this.getFlowKey(mac, type);

    if (typeof flow !== 'object') {
      throw new Error("Invalid flow type: " + typeof flow);
    }

    let result = await rclient.zscoreAsync(key, JSON.stringify(flow));

    if (result == null) {
      return false;
    } else {
      return true;
    }
  }

  queryFlows(mac, type, begin, end) {
    let key = this.getFlowKey(mac, type);

    return rclient.zrangebyscoreAsync(key, "(" + begin, end) // char '(' means open interval
      .then((flowStrings) => {
        return flowStrings.map((flowString) => JSON.parse(flowString)).filter((x) => this._isFlowValid(x));
      })
  }

  getDestIP(flow) {
    if(!flow) {
      return null
    }

    if(flow.lh === flow.sh) {
      return flow.dh;
    } else {
      return flow.sh;
    }
  }

  getDownloadTraffic(flow) {
    if(flow.lh === flow.sh) {
      return flow.rb;
    } else {
      return flow.ob;
    }
  }

  getUploadTraffic(flow) {
    if(flow.lh === flow.sh) {
      return flow.ob;
    } else {
      return flow.rb;
    }
  }
  getTrafficPort(flow) {
    let port;
    if(flow.fd == "out"){
      port = flow.sp
    }else{
      port = flow.dp
    }
    if(Array.isArray(port)){
      return port
    }else{
      return [port]
    }
  }
}

module.exports = function() {
  return new FlowTool();
};
