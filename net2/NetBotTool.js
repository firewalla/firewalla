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

const util = require('util');

const FlowAggrTool = require('./FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const HostTool = require('./HostTool');
const hostTool = new HostTool();

const AppFlowTool = require('../flow/AppFlowTool.js')
const appFlowTool = new AppFlowTool()

const flowTool = require('./FlowTool.js')();

const CategoryFlowTool = require('../flow/CategoryFlowTool.js')
const categoryFlowTool = new CategoryFlowTool()

const rclient = require('../util/redis_manager.js').getRedisClient()

let instance = null;

function toInt(n){ return Math.floor(Number(n)); };


class NetBotTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  async loadSystemStats(json) {
    const systemFlows = {};

    const keys = ['upload', 'download'];

    for(const key of keys) {
      const lastSumKey = `lastsumflow:${key}`;
      const realSumKey = await rclient.getAsync(lastSumKey);
      if(!realSumKey) {
        continue;
      }

      const elements = realSumKey.split(":")
      if(elements.length !== 4) {
        continue;
      }

      const begin = elements[2];
      const end = elements[3];

      const traffic = await flowAggrTool.getTopSumFlowByKeyAndDestination(realSumKey, 50);

      const enriched = (await flowTool.enrichWithIntel(traffic)).sort((a, b) => {
        return b.count - a.count;
      });

      systemFlows[key] = {
        begin,
        end,
        flows: enriched
      }
    }

    const actitivityKeys = ['app', 'category'];

    for(const key of actitivityKeys) {

      const lastSumKey = `lastsumflow:${key}`;
      const realSumKey = await rclient.getAsync(lastSumKey);
      if(!realSumKey) {
        continue;
      }
      
      const elements = realSumKey.split(":")
      if(elements.length !== 4) {
        continue;
      }

      const begin = elements[2];
      const end = elements[3];
  
      const traffic = await flowAggrTool.getXYActivitySumFlowByKey(realSumKey, key, 50);
        
      traffic.sort((a, b) => {
        return b.count - a.count;
      });

      systemFlows[key] = {
        begin,
        end,
        activities: traffic
      }  
    }

    json.systemFlows = systemFlows;
  }

  prepareTopDownloadFlows(json, options) {
    return this._prepareTopFlows(json, "download", options);
  }

  prepareTopUploadFlows(json, options) {
    return this._prepareTopFlows(json, "upload", options);
  }

  async prepareCategoryActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting category flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "category", begin, end);

    let traffic = await flowAggrTool.getCategoryActivitySumFlowByKey(sumFlowKey, 50);

    traffic.sort((a, b) => {
      return b.count - a.count;
    });

    for (const t of traffic) {
      let mac = t.device;
      let host = await hostTool.getMACEntry(mac);
      let name = hostTool.getHostname(host);
      t.deviceName = name;
    };

    json.flows.categories = traffic;
  }

  // app
  async prepareAppActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting app flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "app", begin, end);

    let traffic = await flowAggrTool.getAppActivitySumFlowByKey(sumFlowKey, 50);

    traffic.sort((a, b) => {
      return b.count - a.count;
    });

    for (const t of traffic) {
      let mac = t.device;
      let host = await hostTool.getMACEntry(mac);
      let name = hostTool.getHostname(host);
      t.deviceName = name;
    }

    json.flows.apps = traffic;
  }

  async prepareDetailedAppFlowsFromCache(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`[Cache] Getting app detail flows between ${beginString} and ${endString}`)

    let key = 'appDetails'
    //    json.flows[key] = {}

    let flows = await flowAggrTool.getCleanedAppActivity(begin, end, options)
    if (flows) {
      json.flows[key] = flows
    }
  }
  
  async prepareDetailedAppFlows(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`Getting app detail flows between ${beginString} and ${endString}`)

    let key = 'appDetails'
    json.flows[key] = {}

    let apps = await appFlowTool.getApps('*') // all mac addresses

    let allFlows = {}

    for (const app of apps) {
      allFlows[app] = []

      let macs = await appFlowTool.getAppMacAddresses(app)

      for (const mac of macs) {
        let appFlows = await appFlowTool.getAppFlow(mac, app, options)
        appFlows = appFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
        appFlows.forEach((f) => {
          f.device = mac
        })

        allFlows[app].push.apply(allFlows[app], appFlows)
      }

      allFlows[app].sort((a, b) => {
        return b.ts - a.ts;
      });
    }

    json.flows[key] = allFlows
  }


  async prepareDetailedCategoryFlowsFromCache(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`[Cache] Getting category detail flows between ${beginString} and ${endString}`)

    let key = 'categoryDetails'
//    json.flows[key] = {}

    let flows = await flowAggrTool.getCleanedCategoryActivity(begin, end, options)
    if (flows) {
      json.flows[key] = flows
    }
  }

  async prepareDetailedCategoryFlows(json, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(`Getting category detail flows between ${beginString} and ${endString}`)

    let key = 'categoryDetails'
    json.flows[key] = {}

    let categories = await categoryFlowTool.getCategories('*') // all mac addresses

    // ignore intel category, intel is only for internal logic
    categories = categories.filter((x) => x.toLowerCase() !== "intel")

    let allFlows = {}

    for (const category of categories) {
      allFlows[category] = []

      let macs = await categoryFlowTool.getCategoryMacAddresses(category)

      for (const mac of macs) {
        let categoryFlows = await categoryFlowTool.getCategoryFlow(mac, category, options)
        categoryFlows = categoryFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
        categoryFlows.forEach((f) => {
          f.device = mac
        })

        allFlows[category].push.apply(allFlows[category], categoryFlows)
      }

      allFlows[category].sort((a, b) => {
        return b.ts - a.ts;
      });
    }

    json.flows[key] = allFlows
  }

  // Top Download/Upload in the entire network
  async _prepareTopFlows(json, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, trafficDirection, begin, end);

    let traffic = await flowAggrTool.getTopSumFlowByKey(sumFlowKey, 50);

    traffic.forEach((f) => {
      f.begin = begin;
      f.end = end;
    })

    let enriched = await flowTool.enrichWithIntel(traffic);

    json.flows[trafficDirection] = enriched.sort((a, b) => {
      return b.count - a.count;
    });
    return traffic
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

  async _prepareTopFlowsForHost(json, mac, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    json.flows[trafficDirection] = []

    let flowKey = null

    if(options.queryall) {
      flowKey = await flowAggrTool.getLastSumFlow(mac, trafficDirection);
    } else {
      flowKey = await flowAggrTool.getSumFlowKey(mac, trafficDirection, options.begin, options.end);
    }

    if (flowKey) {
      let traffic = await flowAggrTool.getTopSumFlowByKey(flowKey, 20); // get top 20

      let ts = this._getTimestamps(flowKey);

      if (ts) {
        traffic.map((f) => {
          f.begin = ts.begin
          f.end = ts.end
        })
      }

      let enriched = await flowTool.enrichWithIntel(traffic);

      json.flows[trafficDirection] = enriched.sort((a, b) => {
        return b.count - a.count;
      });
    }
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

  // looks like this is no longer used
  async prepareDetailedAppFlowsForHost(json, mac, options) {
    if (!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    let key = 'appDetails'
    json.flows[key] = {}

    let apps = await appFlowTool.getApps(mac)

    let allFlows = {}

    for (const app of apps) {
      let appFlows = await appFlowTool.getAppFlow(mac, app, options)
      appFlows = appFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
      allFlows[app] = appFlows
    }

    json.flows[key] = allFlows
  }
  
  async prepareDetailedAppFlowsForHostFromCache(json, mac, options) {
    if (!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    options = JSON.parse(JSON.stringify(options))

    let key = 'appDetails'
    json.flows[key] = {}

    let appFlows = null

    if (options.queryall) {
      // need to support queryall too
      let lastAppActivityKey = await flowAggrTool.getLastAppActivity(mac)
      if (lastAppActivityKey) {
        appFlows = await flowAggrTool.getCleanedAppActivityByKey(lastAppActivityKey)
      }
    } else {
      options.mac = mac
      appFlows = await flowAggrTool.getCleanedAppActivity(options.begin, options.end, options)
    }

    if (appFlows) {
      json.flows[key] = appFlows
    }
  }

  // looks like this is no longer used
  async prepareDetailedCategoryFlowsForHost(json, mac, options) {
    if (!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    let key = 'categoryDetails'
    json.flows[key] = {}

    let categories = await categoryFlowTool.getCategories(mac)

    // ignore intel category, intel is only for internal logic
    categories = categories.filter((x) => x.toLowerCase() !== "intel")

    let allFlows = {};

    for (const category of categories) {
      let categoryFlows = await categoryFlowTool.getCategoryFlow(mac, category, options)
      categoryFlows = categoryFlows.filter((f) => f.duration >= 5)
      allFlows[category] = categoryFlows
    }

    json.flows[key] = allFlows
  }

  async prepareDetailedCategoryFlowsForHostFromCache(json, mac, options) {
    if (!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    options = JSON.parse(JSON.stringify(options))

    let key = 'categoryDetails'
    json.flows[key] = {}

    let categories = await categoryFlowTool.getCategories(mac)

    // ignore intel category, intel is only for internal logic
    categories = categories.filter((x) => x.toLowerCase() !== "intel")

    let categoryFlows = null

    if (options.queryall) {
      // need to support queryall too
      let lastCategoryActivityKey = await flowAggrTool.getLastCategoryActivity(mac)
      if (lastCategoryActivityKey) {
        categoryFlows = await flowAggrTool.getCleanedCategoryActivityByKey(lastCategoryActivityKey)
      }
    } else {
      options.mac = mac
      categoryFlows = await flowAggrTool.getCleanedCategoryActivity(options.begin, options.end, options)
    }

    if (categoryFlows) {
      json.flows[key] = categoryFlows
    }
  }

  async prepareCategoryActivityFlowsForHost(json, mac, options) {
    if (!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.categories = [];

    let flowKey = await flowAggrTool.getLastSumFlow(mac, "category");
    if (flowKey) {
      let traffic = await flowAggrTool.getCategoryActivitySumFlowByKey(flowKey, 20) // get top 20

      traffic.sort((a, b) => {
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
  }

  async prepareAppActivityFlowsForHost(json, mac, options) {
    if (!mac) {
      return Promise.reject("Invalid MAC Address");
    }

    json.flows.apps = [];

    let flowKey = await flowAggrTool.getLastSumFlow(mac, "app");
    if (flowKey) {
      let traffic = await flowAggrTool.getAppActivitySumFlowByKey(flowKey, 20) // get top 20

      traffic.sort((a, b) => {
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
  }

}


module.exports = NetBotTool;
