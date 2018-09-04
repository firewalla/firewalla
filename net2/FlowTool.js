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

const rclient = require('../util/redis_manager.js').getRedisClient()
let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let DNSManager = require('./DNSManager.js');
let dnsManager = new DNSManager('info');

let async2 = require('async');

let util = require('util');

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

let DestIPFoundHook = require('../hook/DestIPFoundHook');
let destIPFoundHook = new DestIPFoundHook();

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

let country = require('../extension/country/country.js');

const MAX_RECENT_INTERVAL = 24 * 60 * 60; // one day
const QUERY_MAX_FLOW = 10000;
const MAX_RECENT_FLOW = 150;
const MAX_CONCURRENT_ACTIVITY = 10;

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

  _getRemoteIP(flow) {
    if (flow.sh === flow.lh) {
      return flow.dh;
    } else {
      return flow.sh;
    }
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

  prepareRecentFlows(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    json.flows.recent = [];

    return async(() => {

      let flows = await(this.getAllRecentOutgoingConnections(options))
      flows = flows.slice(0, MAX_RECENT_FLOW);

      let flows2 = await(this.getAllRecentIncomingConnections(options))
      flows2 = flows2.slice(0, MAX_RECENT_FLOW);

      Array.prototype.push.apply(json.flows.recent, flows);
      Array.prototype.push.apply(json.flows.recent, flows2);

      json.flows.recent.sort((a, b) => {
        return b.ts - a.ts;
      })
    })();
  }

  prepareRecentFlowsForHost(json, mac, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    json.flows.recent = [];

    return async(() => {
      let ips = await (hostTool.getIPsByMac(mac));
      let allFlows = [];
      ips.forEach((ip) => {
        let flows = await(this.getRecentOutgoingConnections(ip, options));
        flows.forEach((f) => {
          f.device = mac;
        });
        allFlows.push.apply(allFlows, flows);

        let flows2 = await(this.getRecentIncomingConnections(ip, options));
        flows2.forEach((f) => {
          f.device = mac;
        });
        allFlows.push.apply(allFlows, flows2);
      })

      allFlows.sort((a, b) => {
        return b.ts - a.ts;
      })

      Array.prototype.push.apply(json.flows.recent, allFlows);
    })();
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

    if(flow.lh === flow.sh) {
      f.ip = flow.dh;
      f.upload = flow.ob;
      f.download = flow.rb;
    } else {
      f.ip = flow.sh;
      f.upload = flow.rb;
      f.download = flow.ob;
    }

    return f;
  }

  getRecentOutgoingConnections(ip, options) {
    return this.getRecentConnections(ip, "in", options)
  }

  getRecentIncomingConnections(ip, options) {
    return this.getRecentConnections(ip, "out", options);
  }


  getAllRecentOutgoingConnections(options) {
    return this.getAllRecentConnections("in", options)
  }

  getAllRecentIncomingConnections(options) {
    return this.getAllRecentConnections("out", options);
  }

  getAllRecentOutgoingConnectionsMixed(options) {
    return async(() => {

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

      const outgoing = await (this.getAllRecentOutgoingConnections(options))
      const incoming = await (this.getAllRecentIncomingConnections(options))

      const all = outgoing.concat(incoming)

      all.sort((a, b) => a.ip < b.ip)      
      
      let merged = []
      let last_entry = null

      for (let i = 0; i < all.length; i++) {
        const entry = all[i];
        if(last_entry === null) {
          last_entry = entry
        } else {
          if(last_entry.ip === entry.ip) {
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
    })()
  }

  // this is to get all recent connections in the network
  // regardless which device it belongs to
  getAllRecentConnections(direction, options) {
    options = options || {}

    options = JSON.parse(JSON.stringify(options)) // get a clone to avoid side impact to other functions

    let to = options.end || new Date() / 1000;
    let from = options.begin || (to - MAX_RECENT_INTERVAL);

    return async(() => {
      let allIPs = await (hostTool.getAllIPs());
      let allFlows = [];
      allIPs.forEach((ips_mac) => {
        let ips = ips_mac.ips
        ips.forEach((ip) => {
          options.mac = ips_mac.mac;
          let flows = await (this.getRecentConnections(ip, direction, options));
          flows.map((flow) => {
            flow.device = ips_mac.mac
          })

          allFlows.push.apply(allFlows, flows);


        })
      });

      allFlows.sort((a, b) => {
        return b.ts - a.ts;
      })

      return allFlows;
    })();
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

  async _getTransferTrend(ip, destinationIP, options) {
    options = options || {};
    const end = options.end || Math.floor(new Date() / 1000);
    const begin = options.begin || end - 3600 * 6; // 6 hours
    const direction = options.direction || 'in';
    
    const key = util.format("flow:conn:%s:%s", direction, ip);

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
        ob: x.ob,
        rb: x.rb
      }
    })

    return list;
  }

  async getTransferTrend(deviceMAC, destinationIP, options) {
    options = options || {};
    
    const results = await hostTool.getIPsByMac(deviceMAC);

    const transfers = [];

    for (let index = 0; index < results.length; index++) {
      const ip = results[index];
      const t_in = await this._getTransferTrend(ip, destinationIP, options);
      transfers.push.apply(transfers, t_in);

      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.direction = 'out';
      const t_out = await this._getTransferTrend(ip, destinationIP, optionsCopy);
      transfers.push.apply(transfers, t_out);
    }

    return this._aggregateTransferBy10Min(transfers);
  }

  getRecentConnections(ip, direction, options) {
    options = options || {};

    let max_recent_flow = options.maxRecentFlow || MAX_RECENT_FLOW;

    let key = util.format("flow:conn:%s:%s", direction, ip);
    let to = options.end || new Date() / 1000;
    let from = options.begin || (to - MAX_RECENT_INTERVAL);

    return async(() => {
      let results = await (rclient.zrevrangebyscoreAsync([key, to, from, "LIMIT", 0 , max_recent_flow]));

      if(results === null || results.length === 0)
        return [];

      let flowObjects = results
        .map((x) => this._flowStringToJSON(x))
        .filter((x) => this._isFlowValid(x));

      flowObjects.forEach((x) => this.trimFlow(x));

      let mergedFlow = null

      if(!options.no_merge) {
        mergedFlow = this._mergeFlows(flowObjects.sort((a, b) => b.ts - a.ts)); 
      } else {
        mergedFlow = flowObjects
      }
      
      let simpleFlows = mergedFlow
            .map((f) => this.toSimpleFlow(f))
            .map((f) => {
              if(options.mac) {
                f.device = options.mac; // record the mac address here
              }
              return f;
            });

      let promises = Promise.all(simpleFlows.map((f) => {
        return intelTool.getIntel(f.ip)
        .then((intel) => {
          if(intel) {
            f.country = intel.country;
            f.host = intel.host;
            if(intel.category) {
              f.category = intel.category
            }
            if(intel.app) {
              f.app = intel.app
            }
            return f;
          } else {
            return f;
            // intel not exists in redis, create a new one
            return async(() => {
              try {
                intel = await (destIPFoundHook.processIP(f.ip));
                if(intel) {
                  f.country = intel.country;
                  f.host = intel.host;
                  if(intel.category) {
                    f.category = intel.category
                  }
                  if(intel.app) {
                    f.app = intel.app
                  }
                }             
              } catch(err) {
                log.error(`Failed to post-enrich intel ${f.ip}:`, err);
              }              
              
              return f;
            })();
          }
          return f;
        });
      })).then(() => {
        return simpleFlows.sort((a, b) => {
          return b.ts - a.ts;
        })
      });

      return promises;
    })();
  }

  getFlowKey(ip, type) {
    return util.format("flow:conn:%s:%s", type, ip);
  }
  addFlow(ip, type, flow) {
    let key = this.getFlowKey(ip, type);

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return rclient.zaddAsync(key, flow.ts, JSON.stringify(flow));
  }

  removeFlow(ip, type, flow) {
    let key = this.getFlowKey(ip, type);

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return rclient.zremAsync(key, JSON.stringify(flow))
  }

  flowExists(ip, type, flow) {
    let key = this.getFlowKey(ip, type);

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return async(() => {
      let result = await(rclient.zscoreAsync(key, JSON.stringify(flow)));

      if(result == null) {
        return false;
      } else {
        return true;
      }
    })();
  }

  queryFlows(ip, type, begin, end) {
    let key = this.getFlowKey(ip, type);

    return rclient.zrangebyscoreAsync(key, "(" + begin, end) // char '(' means open interval
      .then((flowStrings) => {
        return flowStrings.map((flowString) => JSON.parse(flowString));
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
}

module.exports = function() {
  return new FlowTool();
};
