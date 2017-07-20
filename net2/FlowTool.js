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

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let SysManager = require('./SysManager.js');
let sysManager = new SysManager('info');

let DNSManager = require('./DNSManager.js');
let dnsManager = new DNSManager('info');

let async = require('async');

let country = require('../extension/country/country.js');

const MAX_RECENT_INTERVAL = 24 * 60 * 60; // one day
const QUERY_MAX_FLOW = 10000;
const MAX_RECENT_FLOW = 50; 
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
    
    if("f" in flow)
      delete flow.f;
    
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
    if ( !o.rb || !o.ob ) {
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
      flow.country = country.getCountry(dh);
    } else {
      flow.country = country.getCountry(sh);
    }
  }
  
  // FIXME: support dynamically load intel from cloud
  _enrichDNSInfo(flows) {

    return new Promise((resolve, reject) => {
      async.eachLimit(flows, MAX_CONCURRENT_ACTIVITY, (flow, cb) => {
        let ip = this._getRemoteIP(flow);

        dnsManager.resolvehost(ip, (err, info, dnsData) => {
          if (err) {
            cb(err);
            return;
          }

          if (info && info.name) {
            flow.dhname = info.name;
          }

          cb();
        });
      }, (err) => {
        if(err) {
          reject(err);
          return;
        }
        
        resolve(flows);
      });
    });
    
  }

  prepareRecentFlowsForHost(json, listip) {
    if (!("flows" in json)) {
      json.flows = {};
    }
    
    json.flows.time = [];

    let promises = listip.map((ip) => {
      return this.getRecentOutgoingConnections(ip)
        .then((flows) => {
          Array.prototype.push.apply(json.flows.time, flows);
          return json;
        })
    });

    return Promise.all(promises);

  }
  
  getRecentOutgoingConnections(ip) {
    
    let key = "flow:conn:in:" + ip;
    let to = new Date() / 1000;
    let from = to - MAX_RECENT_INTERVAL;

    return rclient.zrevrangebyscoreAsync([key, to, from, "LIMIT", 0 , MAX_RECENT_FLOW])
      .then((results) => {

        if(results === null || results.length === 0)
          return [];

        let flowObjects = results
          .map((x) => this._flowStringToJSON(x))
          .filter((x) => this._isFlowValid(x));
        
        flowObjects.forEach((x) => this.trimFlow(x));

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
        
        // add country info
        mergedFlowObjects.forEach(this._enrichCountryInfo);
        
        return this._enrichDNSInfo(mergedFlowObjects);

      }).catch((err) => {
        log.error("Failed to query flow data for ip", ip, ":", err, err.stack, {});
      });
  }
  
  
}

module.exports = function() {
  return new FlowTool();
};