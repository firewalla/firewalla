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

const RECENT_INTERVAL = 15 * 60; // 15 mins
const QUERY_MAX_FLOW = 10000;

let instance = null;
class FlowTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  static _mergeFlow(targetFlow, flow) {
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

  static _getKey(flow, ip) {
    let key = "";
    if (flow.sh === ip) {
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

  static _flowStringToJSON(flow) {
    try {
      return JSON.parse(flow);
    } catch(err) {
      return null;
    }
  }

  static _isFlowValid(flow) {
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
  
  getRecentOutgoingConnections(ip) {
    let key = "flow:conn:in:" + ip;
    let to = new Date() / 1000;
    let from = to - RECENT_INTERVAL;

    return rclient.zrevrangebyscoreAsync([key, to, from, "LIMIT", 0 , QUERY_MAX_FLOW])
      .then((results) => {

        if(results === null || results.length === 0)
          return [];

        let flowObjects = results
          .map((x) => FlowTool._flowStringToJSON(x))
          .filter((x) => FlowTool._isFlowValid(x));

        let mergedFlowObjects = [];
        let lastFlowObject = null;

        flowObjects.forEach((flowObject) => {
          if(!lastFlowObject) {
            mergedFlowObjects.push(flowObject);
            lastFlowObject = flowObject;
            return;
          }
          
          if (FlowTool._getKey(lastFlowObject) === FlowTool._getKey(flowObject)) {
            FlowTool._mergeFlow(lastFlowObject, flowObject);
          } else {
            mergedFlowObjects.push(flowObject);
            lastFlowObject = flowObject;
          }
        });
        
        return mergedFlowObjects;

      }).catch((err) => {
        log.error("Failed to query flow data for ip", ip, ":", err, err.stack, {});
      });
  }
}

module.exports = function() {
  return new FlowTool();
};