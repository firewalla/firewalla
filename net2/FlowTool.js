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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const util = require('util');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const DestIPFoundHook = require('../hook/DestIPFoundHook');
const destIPFoundHook = new DestIPFoundHook();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const country = require('../extension/country/country.js');

const MAX_RECENT_INTERVAL = 24 * 60 * 60; // one day
const MAX_RECENT_FLOW = 100;

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

    if("bl" in flow)
      delete flow.bl;

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
    targetFlow.rb += flow.rb;
    targetFlow.ct += flow.ct;
    targetFlow.ob += flow.ob;
    targetFlow.du += flow.du;
    if (targetFlow.ts < flow.ts) {
      targetFlow.ts = flow.ts;
    }
    if (flow.pf) {
      for (let k in flow.pf) {
        if (targetFlow.pf[k] != null) {
          targetFlow.pf[k].rb += flow.pf[k].rb;
          targetFlow.pf[k].ob += flow.pf[k].ob;
          targetFlow.pf[k].ct += flow.pf[k].ct;
        } else {
          targetFlow.pf[k] = flow.pf[k]
        }
      }
    }

    if (flow.flows) {
      if (targetFlow.flows) {
        targetFlow.flows = targetFlow.flows.concat(flow.flows);
      } else {
        targetFlow.flows = flow.flows;
      }
    }
  }

  _getKey(flow) {
    let key = "";
    if (flow.sh === flow.lh) {
      key = flow.dh + ":" + flow.fd;
    } else {
      key = flow.sh + ":" + flow.fd;
    }
    return key;
  }

  // append to existing flow or create new
  _appendFlow(conndb, flowObject, ip) {
    let o = flowObject;

    let key = this._getKey(o, ip);

    let flow = conndb[key];
    if (flow == null) {
      conndb[key] = o;
    } else {
      this._mergeFlow(flow, o);
    }
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
      flow.country = country.getCountry(dh)
    } else {
      flow.country = country.getCountry(sh)
    }
  }

  async prepareRecentFlows(json, options) {
    options = options || {}
    if (!options.count || options.count > MAX_RECENT_FLOW) options.count = MAX_RECENT_FLOW
    if (!options.asc) options.asc = false;

    if (!("flows" in json)) {
      json.flows = {};
    }

    let outgoing, incoming;
    if (options.mac) {
      outgoing = await this.getRecentOutgoingConnections(options.mac, options);
      incoming = await this.getRecentIncomingConnections(options.mac, options);
    }
    else {
      outgoing = await this.getAllRecentOutgoingConnections(options)
      incoming = await this.getAllRecentIncomingConnections(options)
    }

    let recentFlows = _.orderBy(outgoing.concat(incoming), 'ts', options.asc ? 'asc' : 'desc')
      .slice(0, options.count);

    json.flows.recent = recentFlows;

    return recentFlows
  }

  // merge adjacent flows with same key via this._getKey()
  _mergeFlows(flowObjects) {
    let mergedFlowObjects = [];
    let lastFlowObject = null;

    flowObjects.forEach((flowObject) => {
      if(!lastFlowObject) {
        mergedFlowObjects.push(flowObject);
        lastFlowObject = flowObject;
        return;
      }

      if (this._getKey(lastFlowObject) === this._getKey(flowObject)) {
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

    f.ts = flow.ts;
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

  async getAllRecentOutgoingConnectionsMixed(options) {

    //   {
    //     country = US;
    //     device = "9C:3D:CF:FA:95:75";
    //     download = 11984;
    //     duration = "1.121203";
    //     fd = in;
    //     host = "logs.us-west-2.amazonaws.com";
    //     ip = "52.94.209.50";
    //     ts = "1519653614.804147";
    //     upload = 1392;
    // }

    const outgoing = await this.getAllRecentOutgoingConnections(options)
    const incoming = await this.getAllRecentIncomingConnections(options)

    const all = outgoing.concat(incoming)

    all.sort((a, b) => a.ip < b.ip)

    let merged = []
    let last_entry = null

    for (let i = 0; i < all.length; i++) {
      const entry = all[i];
      if (last_entry === null) {
        last_entry = entry
      } else {
        if (last_entry.ip === entry.ip) {
          last_entry.upload += entry.upload
          last_entry.download += entry.download
          last_entry.duration = parseFloat(last_entry.duration) + parseFloat(entry.duration)
        } else {
          merged.push(last_entry)
          last_entry = entry
        }
      }
    }

    merged.push(last_entry)

    return merged
  }

  // this is to get all recent connections in the network
  // regardless which device it belongs to
  async getAllRecentConnections(direction, options) {
    options = options || {}

    const allMacs = await hostTool.getAllMACs();

    const allFlows = [];

    await Promise.all(allMacs.map(async mac => {
      const optionsCopy = JSON.parse(JSON.stringify(options)) // get a clone to avoid side impact to other functions

      optionsCopy.mac = mac; // Why is options.mac set here? This function get recent connections of the entire network. It seems that a specific mac address doesn't make any sense.
      let flows = await this.getRecentConnections(mac, direction, optionsCopy);

      flows.map((flow) => {
        flow.device = mac
      });

      allFlows.push.apply(allFlows, flows);
    }));

    allFlows.sort((a, b) => {
      return b.ts - a.ts;
    })

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

  async saveGlobalRecentConns(flow) {
    const key = "flow:global:recent";
    const now = new Date() / 1000;
    const limit = -1001; // only keep the latest 1000 entries
    let flowCopy = JSON.parse(JSON.stringify(flow));

    if(!this._isFlowValid(flowCopy)) {
      return;
    }

    // TODO: might need to cut small traffics
    flowCopy = this.toSimpleFlow(flowCopy);
    flowCopy.now = now;

    // if(flowCopy.deviceIP && !flowCopy.device) {
    //   const mac = await hostTool.getMacByIP(flowCopy.deviceIP);
    //   flowCopy.device = mac;
    // }

    await rclient.zaddAsync(key, now, JSON.stringify(flowCopy));
    await rclient.zremrangebyrankAsync(key, 0, limit);

    for (let index = 0; index < flowCopy.tags.length; index++) {
      const tag = flowCopy.tags[index];
      const tagKey = `flow:tag:${tag}:recent`;
      await rclient.zaddAsync(tagKey, now, JSON.stringify(flowCopy));
      await rclient.zremrangebyrankAsync(key, 0, limit);
    }

    const intfKey = `flow:intf:${flowCopy.intf}:recent`;
    await rclient.zaddAsync(intfKey, now, JSON.stringify(flowCopy));
    await rclient.zremrangebyrankAsync(key, 0, limit);

    return;
  }

  async enrichWithIntel(flows) {
    return await Promise.all(flows.map(async f => {
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
    }));
  }

  async getGlobalRecentConns(options) {
    options = options || {};

    const key = "flow:global:recent";
    const limit = options.limit || 50;
    let offset = options.offset || "-inf";

    if(offset !== '-inf') {
      offset = `(${offset}`;
    }

    const results = await rclient.zrangebyscoreAsync([key, offset, "+inf", "LIMIT", 0 , limit]);

    if(_.isEmpty(results)) {
      return [];
    }

    let flowObjects = results
        .map((x) => this._flowStringToJSON(x));

    let enrichedFlows = await this.enrichWithIntel(flowObjects);

    enrichedFlows.sort((a, b) => {
      return b.ts - a.ts;
    });

    return enrichedFlows;
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
      if (x.ets) x.ts = x.ets
    });

    let mergedFlow = null

    if(!options.no_merge) {
      mergedFlow = this._mergeFlows(
        _.orderBy(flowObjects, 'ts', options.asc ? 'asc' : 'desc')
      );
    } else {
      mergedFlow = flowObjects
    }

    let simpleFlows = mergedFlow
      .map((f) => {
        let s = this.toSimpleFlow(f)
        s.device = target; // record the mac address here
        return s;
      });

    let enrichedFlows = await this.enrichWithIntel(simpleFlows);

    return _.orderBy(enrichedFlows, 'ts', options.asc ? 'asc' : 'desc')
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
