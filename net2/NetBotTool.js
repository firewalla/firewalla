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

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let async2 = require('async');

let util = require('util');

let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

let DestIPFoundHook = require('../hook/DestIPFoundHook');
let destIPFoundHook = new DestIPFoundHook();

let instance = null;

class NetBotTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  prepareTopDownloadFlows(json, options) {
    return this._prepareTopFlows(json, "download", options);
  }

  prepareTopUploadFlows(json, options) {
    return this._prepareTopFlows(json, "upload", options);
  }

  prepareActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "app", begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getActivitySumFlowByKey(sumFlowKey, 50));

      traffic.sort((a, b) => {
          return b.count - a.count;
      });

      json.flows.apps = traffic;
    })();
  }

  // Top Download/Upload in the entire network
  _prepareTopFlows(json, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, trafficDirection, begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getTopSumFlowByKey(sumFlowKey, 50));

      let promises = Promise.all(traffic.map((f) => {
        return intelTool.getIntel(f.ip)
        .then((intel) => {
          if(intel) {
            f.country = intel.country;
            f.host = intel.host;
            return f;
          } else {
            // intel not exists in redis, create a new one
            return async(() => {
              intel = await (destIPFoundHook.processIP(f.ip));
              f.country = intel.country;
              f.host = intel.host;
              return f;
            })();
          }
          return f;
        });
      })).then(() => {
        return traffic.sort((a, b) => {
          return b.count - a.count;
        });
      });

      await (promises);

      json.flows[trafficDirection] = traffic
    })();
  }

  _prepareTopFlowsForHost(json, mac, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    json.flows[trafficDirection] = []

    return async(() => {
      let flowKey = await (flowAggrTool.getLastSumFlow(mac, trafficDirection));
      if (flowKey) {
        let traffic = await (flowAggrTool.getTopSumFlowByKey(flowKey,20)) // get top 20

        let promises = Promise.all(traffic.map((f) => {
          return intelTool.getIntel(f.ip)
          .then((intel) => {
            if(intel) {
              f.country = intel.country;
              f.host = intel.host;
              return f;
            } else {
              // intel not exists in redis, create a new one
              return async(() => {
                intel = await (destIPFoundHook.processIP(f.ip));
                f.country = intel.country;
                f.host = intel.host;
                return f;
              })();
            }
            return f;
          });
        })).then(() => {
          return traffic.sort((a, b) => {
            return b.count - a.count;
          });
        });

        await (promises);

        json.flows[trafficDirection] = traffic
      }
    })();
  }

  prepareTopDownloadFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }
    return this._prepareTopFlowsForHost(json, mac, "download", options);
  }

  prepareTopUploadFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    return this._prepareTopFlowsForHost(json, mac, "upload", options);
  }

  prepareActivitiesFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.apps = [];

    return async(() => {
      let flowKey = await (flowAggrTool.getLastSumFlow(mac, "app"));
      if (flowKey) {
        let traffic = await (flowAggrTool.getActivitySumFlowByKey(flowKey,20)) // get top 20

        traffic.sort((a,b) => {
          return b.count - a.count;
        });

        json.flows.apps = traffic;
      }
    })();
  }

}


module.exports = NetBotTool;
