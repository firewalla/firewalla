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

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

let AppFlowTool = require('../flow/AppFlowTool.js')
let appFlowTool = new AppFlowTool()

let CategoryFlowTool = require('../flow/CategoryFlowTool.js')
let categoryFlowTool = new CategoryFlowTool()

let instance = null;

function toInt(n){ return Math.floor(Number(n)); };


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

  prepareCategoryActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting category flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "category", begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getCategoryActivitySumFlowByKey(sumFlowKey, 50));

      traffic.sort((a, b) => {
        return b.count - a.count;
      });

      traffic.forEach((t) => {
        let mac = t.device;
        let host = await (hostTool.getMACEntry(mac));
        let name = hostTool.getHostname(host);
        t.deviceName = name;
      });

      json.flows.categories = traffic;
    })();
  }

  // app
  prepareActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting app flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "app", begin, end);

    return async(() => {
      let traffic = await (flowAggrTool.getAppActivitySumFlowByKey(sumFlowKey, 50));

      traffic.sort((a, b) => {
        return b.count - a.count;
      });

      traffic.forEach((t) => {
        let mac = t.device;
        let host = await (hostTool.getMACEntry(mac));
        let name = hostTool.getHostname(host);
        t.deviceName = name;
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

      traffic.map((f) => {
        f.begin = begin;
        f.end = end;
      })

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

  // "sumflow:8C:29:37:BF:4A:86:upload:1505073000:1505159400"
  _getTimestamps(sumFlowKey) {
    let pattern = /:([^:]*):([^:]*)$/
    let result = sumFlowKey.match(pattern)
    if(!result) {
      return null
    }

    return {
      begin: toInt(result[1]),
      end: toInt(result[2])
    }
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

        let ts = this._getTimestamps(flowKey)

        if(ts) {
          traffic.map((f) => {
            f.begin = ts.begin
            f.end = ts.end
          })
        }


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

  prepareDetailedAppFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    let key = 'appDetails'
    json.flows[key] = {}

    return async(() => {

      let apps = await (appFlowTool.getApps(mac))

      let allFlows = {}

      apps.forEach((app) => {
        let appFlows = await (appFlowTool.getAppFlow(mac, app))
        appFlows = appFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
        allFlows[app] = appFlows
      })

      json.flows[key] = allFlows
    })();
  }

  prepareDetailedCategoryFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    let key = 'categoryDetails'
    json.flows[key] = {}

    return async(() => {

      let categories = await (categoryFlowTool.getCategories(mac))

      let allFlows = {}

      categories.forEach((category) => {
        let categoryFlows = await (categoryFlowTool.getCategoryFlow(mac, category))
        categoryFlows = categoryFlows.filter((f) => f.duration >= 5)
        allFlows[category] = categoryFlows
      })

      json.flows[key] = allFlows
    })();
  }

  prepareCategoryActivityFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.categories = [];

    return async(() => {
      let flowKey = await (flowAggrTool.getLastSumFlow(mac, "category"));
      if (flowKey) {
        let traffic = await (flowAggrTool.getCategoryActivitySumFlowByKey(flowKey,20)) // get top 20

        traffic.sort((a,b) => {
          return b.count - a.count;
        });

        traffic.forEach((t) => {
          delete t.device // no need to keep this record since single host data has same device info
        })

        let categoryTraffics = {}

        traffic.forEach((t) => {
          categoryTraffics[t.category] = t
          delete t.category
        })

        json.flows.categories = categoryTraffics;
      }
    })();
  }

  prepareAppActivityFlowsForHost(json, mac, options) {
    if(!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.apps = [];

    return async(() => {
      let flowKey = await (flowAggrTool.getLastSumFlow(mac, "app"));
      if (flowKey) {
        let traffic = await (flowAggrTool.getAppActivitySumFlowByKey(flowKey,20)) // get top 20

        traffic.sort((a,b) => {
          return b.count - a.count;
        });

        traffic.forEach((t) => {
          delete t.device
        })

        let appTraffics = {}

        traffic.forEach((t) => {
          appTraffics[t.app] = t
          delete t.app
        })

        json.flows.apps = appTraffics;
      }
    })();
  }

}


module.exports = NetBotTool;
