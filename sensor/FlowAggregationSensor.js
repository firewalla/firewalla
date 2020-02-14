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

let log = require('../net2/logger.js')(__filename);

let util = require('util');

let Sensor = require('./Sensor.js').Sensor;

let flowTool = require('../net2/FlowTool')();
let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

let AppFlowTool = require('../flow/AppFlowTool.js')
let appFlowTool = new AppFlowTool()

let CategoryFlowTool = require('../flow/CategoryFlowTool.js')
let categoryFlowTool = new CategoryFlowTool()

let HostTool = require('../net2/HostTool')
let hostTool = new HostTool();

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

let HostManager = require('../net2/HostManager.js');
let hostManager = new HostManager('cli', 'server');

const flowUtil = require('../net2/FlowUtil')

const config = require('../net2/config.js').getConfig();
const excludedCategories = (config.category && config.category.exclude) || [];

const bone = require('../lib/Bone.js');

// This sensor is to aggregate device's flow every 10 minutes

// redis key to store the aggr result is redis zset aggrflow:<device_mac>:download:10m:<ts>

class FlowAggregationSensor extends Sensor {
  constructor() {
    super();
    this.config.interval = 600; // default 10 minutes, might be overwrote by net2/config.json
    this.config.cleanupInterval = 60 * 60 // default one hour
    this.config.flowRange = 24 * 3600 // 24 hours
    this.config.sumFlowExpireTime = 0.5 * 3600 // 30 minutes
    this.config.aggrFlowExpireTime = 24 * 3600 // 24 hours

    this.firstTime = true; // some work only need to be done once, use this flag to check
  }

  async scheduledJob() {
    log.info("Generating summarized flows info...")
    let ts = new Date() / 1000 - 90; // checkpoint time is set to 90 seconds ago
    await this.aggrAll(ts)

    // preload apps and categories to improve performance
    const apps = await appFlowTool.getApps('*'); // all mac addresses
    const categories = await categoryFlowTool.getCategories('*') // all mac addresses

    await this.sumAll(ts, apps, categories)
    await this.updateAllHourlySummedFlows(ts, apps, categories)
    this.firstTime = false;
    log.info("Summarized flow generation is complete");
  }

  async cleanupJob() {
    log.info("Cleaning up app/category flows...")
    await appFlowTool.cleanupAppFlow()
    await categoryFlowTool.cleanupCategoryFlow()
  }

  run() {
    process.nextTick(() => {
      this.scheduledJob();
    });

    // TODO: Need to ensure all ticks will be processed and stored in redis
    setInterval(() => {
      this.scheduledJob();
    }, this.config.interval * 1000)

    setInterval(() => {
      this.cleanupJob()
    }, this.config.cleanupInterval * 1000)
  }

  async trafficGroupByX(flows, x) {
    let traffic = {};

    for (const flow of flows) {
      let destIP = flowTool.getDestIP(flow);
      let intel = await intelTool.getIntel(destIP);

      // skip if no app or category intel
      if(!(intel && (intel.app || intel.category)))
        return;

      let appInfos = [];

      if(intel[x])
        appInfos.push(intel[x])

      appInfos.forEach((app) => {

        // no need to group traffic for these two types in particular, FIXME
        if (excludedCategories.includes(app)) {
          return;
        }

        let t = traffic[app];

        if (! (app in traffic) ) {
            traffic[app] = {
            duration: flow.du,
            ts: flow.ts,
            ets: flow.ets || Date.now() / 1000,
            download: flowTool.getDownloadTraffic(flow),
            upload: flowTool.getUploadTraffic(flow)
          };
        } else {
          // FIXME: Should have more accurate calculation here
          // TBD: this duration calculation also needs to be discussed as the one in BroDetect.processConnData
          // However we use total time from the beginning of first flow to the end of last flow here, since this data is supposed to be shown on app and more user friendly.
          // t.duration += flow.du;
          t.duration = Math.max(flow.ts + flow.du, t.ts + t.duration) - Math.min(flow.ts, t.ts);
          // ts stands for the earliest start timestamp of this kind of activity
          t.ts = Math.min(flow.ts, t.ts);
          t.ets = Math.max(flow.ets, t.ets);
          t.download += flowTool.getDownloadTraffic(flow) || 0;
          t.upload += flowTool.getUploadTraffic(flow) || 0;
        }
      })
    }

    return traffic;
  }

  trafficGroupByApp(flows) {
    return this.trafficGroupByX(flows, "app")
  }

  trafficGroupByCategory(flows) {
    return this.trafficGroupByX(flows, "category")
  }

  // flows => { ip1 => 100KB, ip2 => 2MB }
  trafficGroupByDestIP(flows) {

    let traffic = {};

    flows.forEach((flow) => {

      let destIP = flowTool.getDestIP(flow);

      let t = traffic[destIP];

      if (! (destIP in traffic) ) {
        traffic[destIP] = {upload: 0, download: 0, port:[]};
        t = traffic[destIP];
      }

      t.upload += flowTool.getUploadTraffic(flow);
      t.download += flowTool.getDownloadTraffic(flow);
      for(let port of flowTool.getTrafficPort(flow)){
        port = ""+port;//make sure it is string
        if(t.port.indexOf(port)==-1){
          t.port.push(port)
        }
      }
      t.port.sort((a,b)=>{return a-b})
    });

    return traffic;
  }

  async aggrAll(ts) {
    let now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      throw new Error("aggregation too soon");
    }

    let macs = hostManager.getActiveMACs();
    await Promise.all(macs.map(async mac => {
      log.debug("FlowAggrSensor on mac", mac);
      await this.aggr(mac, ts);
      await this.aggr(mac, ts + this.config.interval);
      await this.aggrActivity(mac, ts);
      await this.aggrActivity(mac, ts + this.config.interval);
    }))
  }

  // this will be periodically called to update the summed flows in last 24 hours
  // for hours between -24 to -2, if any of these flows are created already, don't update
  // for the last hour, it will periodically update every 10 minutes;
  async updateAllHourlySummedFlows(ts, apps, categories) {
    // let now = Math.floor(new Date() / 1000);
    let now = ts; // actually it's NOT now, typically it's 3 mins earlier than NOW;
    let lastHourTick = Math.floor(now / 3600) * 3600;


    if (this.firstTime) {
      // the 24th last hours -> the 2nd last hour
      for (let i = 1; i < 24; i++) {
        let ts = lastHourTick - i * 3600;
        await this.hourlySummedFlows(ts, {
          skipIfExists: true
        }, apps, categories);
      }
    }

    // last hour and this hour
    for (let i = -1; i < 1; i++) {
      let ts = lastHourTick - i * 3600;
      await this.hourlySummedFlows(ts, {
        skipIfExists: false
      }, apps, categories);
    }

  }

  // sum all traffic together, across devices
  async hourlySummedFlows(ts, opts, apps, categories) {
    // ts is the end timestamp of the hour
    ts = Math.floor(ts / 3600) * 3600
    let end = ts;
    let begin = end - 3600;
    let skipIfExists = opts && opts.skipIfExists;

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();
    log.debug(`Aggregating hourly flows for ${beginString} - ${endString}, skipIfExists flag: ${skipIfExists}`)

    let options = {
      begin: begin,
      end: end,
      interval: this.config.interval,
      expireTime: 24 * 3600, // keep for 24 hours
      skipIfExists: skipIfExists,
      max_flow: 200
    }

    await flowAggrTool.addSumFlow("download", options);
    await flowAggrTool.addSumFlow("upload", options);
    await flowAggrTool.addSumFlow("app", options);

    await this.cleanupAppActivity(options, apps); // to filter idle activities

    await flowAggrTool.addSumFlow("category", options);

    await this.cleanupCategoryActivity(options, categories);

    let macs = hostManager.getActiveMACs();

    await Promise.all(macs.map(async mac => {
      if(!mac) {
        return
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));

      optionsCopy.mac = mac
      optionsCopy.expireTime = 3600 * 24 // for each device, the expire time is 24 hours
      await flowAggrTool.addSumFlow("download", optionsCopy);
      await flowAggrTool.addSumFlow("upload", optionsCopy);
      await flowAggrTool.addSumFlow("app", optionsCopy);
      await this.cleanupAppActivity(optionsCopy, apps); // to filter idle activities if updated
      await flowAggrTool.addSumFlow("category", optionsCopy);
      await this.cleanupCategoryActivity(optionsCopy, categories);
    }));
  }

  async sumAll(ts, apps, categories) {
    let now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      throw new Error("sum too soon")
    }

    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.flowRange;


    let options = {
      begin: begin,
      end: end,
      interval: this.config.interval,
      expireTime: this.config.sumFlowExpireTime,
      setLastSumFlow: true,
      max_flow: 200
    }

    await flowAggrTool.addSumFlow("download", options);
    await flowAggrTool.addSumFlow("upload", options);
    await flowAggrTool.addSumFlow("app", options);
    await this.cleanupAppActivity(options, apps); // to filter idle activities
    await flowAggrTool.addSumFlow("category", options);
    await this.cleanupCategoryActivity(options, categories);

    let macs = hostManager.getActiveMACs();

    await Promise.all(macs.map(async mac => {
      const optionsCopy = JSON.parse(JSON.stringify(options));

      optionsCopy.mac = mac;
      await flowAggrTool.addSumFlow("download", optionsCopy);
      await flowAggrTool.addSumFlow("upload", optionsCopy);

      await flowAggrTool.addSumFlow("app", optionsCopy);
      await this.cleanupAppActivity(optionsCopy, apps);

      await flowAggrTool.addSumFlow("category", optionsCopy);
      await this.cleanupCategoryActivity(optionsCopy, categories);
    }))
  }

  async _flowHasActivity(flow, cache) {
    cache = cache || {}

    let destIP = flowTool.getDestIP(flow);

    if(cache && cache[destIP] === 0) {
      return false;
    }

    if(cache && cache[destIP] === 1) {
      return true;
    }

    let intel = await intelTool.getIntel(destIP);
    if(intel == null ||
      (!intel.app && !intel.category)) {
      cache[destIP] = 0;
      return false;
    } else {
      cache[destIP] = 1;
      return true;
    }
  }

  async aggrActivity(macAddress, ts) {
    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.interval;

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    let msg = util.format("Aggregating %s activities between %s and %s", macAddress, beginString, endString)
    log.debug(msg);

    let flows = [];

    let recentFlow = null;

    let cache = {};

    let outgoingFlows = await flowTool.queryFlows(macAddress, "in", begin, end); // in => outgoing
    const outgoingFlowsHavingIntels = [];
    for(const flow of outgoingFlows) {
      const flag = await this._flowHasActivity(flow, cache);
      if(flag) {
       flows.push(flow);
       outgoingFlowsHavingIntels.push(flow);
      }
    }

    recentFlow = this.selectVeryRecentActivity(recentFlow, outgoingFlowsHavingIntels)

    const incomingFlowsHavingIntels = [];
    let incomingFlows = await flowTool.queryFlows(macAddress, "out", begin, end); // out => incoming
    for(const flow of incomingFlows) {
      const flag = await this._flowHasActivity(flow, cache);
      if(flag) {
        flows.push(flow);
        incomingFlowsHavingIntels.push(flow);
      }
    }

    recentFlow = this.selectVeryRecentActivity(recentFlow, incomingFlowsHavingIntels)

    // now flows array should only contain flows having intels

    // record app/category flows by duration
    let appTraffic = await this.trafficGroupByApp(flows);
    await flowAggrTool.addAppActivityFlows(macAddress, this.config.interval, end, appTraffic, this.config.aggrFlowExpireTime);

    let categoryTraffic = await this.trafficGroupByCategory(flows);
    await flowAggrTool.addCategoryActivityFlows(macAddress, this.config.interval, end, categoryTraffic, this.config.aggrFlowExpireTime);

    // record detail app/category flows by upload/download/ts/duration

    await this.recordApp(macAddress, appTraffic);
    await this.recordCategory(macAddress, categoryTraffic);

    if(recentFlow) {
      let recentActivity = await this.getIntel(recentFlow);
      if(recentActivity) {
        await hostTool.updateRecentActivity(macAddress, recentActivity);
      }
    }
  }

  selectVeryRecentActivity(recentActivity, flows) {
    if(flows.length > 0) {
      // assume it's ordered
      let lastOne = flows[flows.length - 1]
      if(recentActivity == null || recentActivity.ts < lastOne.ts) {
        return lastOne
      }
    }

    return recentActivity
  }

  async getIntel(flow) {
    if(!flow) {
      return null
    }

    let destIP = flowTool.getDestIP(flow)
    let intel = await intelTool.getIntel(destIP);
    return {
      ts: flow.ts,
      app: intel && intel.app,
      category: intel && intel.category
    }
  }

  async recordApp(mac, traffic) {
    for(let app in traffic) {
      let object = traffic[app]
      await appFlowTool.addAppFlowObject(mac, app, object)
    }
  }

  async recordCategory(mac, traffic) {
    for(let category in traffic) {

      // FIXME
      // ignore technology and search-portal for better performanced
      if(excludedCategories.includes(category)) {
        continue;
      }
      let object = traffic[category]
      await categoryFlowTool.addCategoryFlowObject(mac, category, object)
    }
  }

  async aggr(macAddress, ts) {
    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.interval;

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    let msg = util.format("Aggregating %s flows between %s and %s", macAddress, beginString, endString)
    log.debug(msg);

    let flows = [];
    let outgoingFlows = await flowTool.queryFlows(macAddress, "in", begin, end); // in => outgoing
    flows.push.apply(flows, outgoingFlows);
    let incomingFlows = await flowTool.queryFlows(macAddress, "out", begin, end); // out => incoming
    flows.push.apply(flows, incomingFlows);

    let traffic = this.trafficGroupByDestIP(flows);
    await flowAggrTool.addFlows(macAddress, "upload", this.config.interval, end, traffic, this.config.aggrFlowExpireTime);
    await flowAggrTool.addFlows(macAddress, "download", this.config.interval, end, traffic, this.config.aggrFlowExpireTime);
  }

  async getAppFlow(app, options) {
    let flows = []

    let macs = []

    if (options.mac) {
      macs = [options.mac]
    } else {
      macs = await appFlowTool.getAppMacAddresses(app)
    }

    for (const mac of macs) {
      let appFlows = await appFlowTool.getAppFlow(mac, app, options)
      appFlows = appFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
      appFlows.forEach((f) => {
        f.device = mac
      })

      flows.push.apply(flows, appFlows)
    }

    flows.sort((a, b) => {
      return b.ts - a.ts
    })

    return flows
  }

  async cleanupAppActivity(options, apps) {
    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    if(options.mac) {
      log.debug(`Cleaning up app activities between ${beginString} and ${endString} for device ${options.mac}`)
    } else {
      log.debug(`Cleaning up app activities between ${beginString} and ${endString}`)
    }

    try {
      if(options.skipIfExists) {
        let exists = await flowAggrTool.cleanedAppKeyExists(begin, end, options)
        if(exists) {
          return
        }
      }

      let allFlows = {}

      for (const app of apps) {
        let flows = await this.getAppFlow(app, options)
        if(flows.length > 0) {
          allFlows[app] = flows
        }
      }

      // allFlows now contains all raw app activities during this range

      let hashCache = {}

      if(Object.keys(allFlows).length > 0) {
        await flowAggrTool.setCleanedAppActivity(begin, end, allFlows, options)

        // change after store
        flowUtil.hashIntelFlows(allFlows, hashCache)
        await bone.flowgraphAsync('summarizeApp', allFlows)
//        let unhashedData = flowUtil.unhashIntelFlows(data, hashCache)
      } else {
        await flowAggrTool.setCleanedAppActivity(begin, end, {}, options) // if no data, set an empty {}
      }
    } catch(err) {
      log.error(`Failed to clean app activity: `, err);
    }
  }

  async getCategoryFlow(category, options) {
    let flows = []

    let macs = []

    if (options.mac) {
      macs = [options.mac]
    } else {
      macs = await categoryFlowTool.getCategoryMacAddresses(category)
    }

    for (const mac of macs) {
      let categoryFlows = await categoryFlowTool.getCategoryFlow(mac, category, options)
      categoryFlows = categoryFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
      categoryFlows.forEach((f) => {
        f.device = mac
      })

      flows.push.apply(flows, categoryFlows)
    }

    flows.sort((a, b) => {
      return b.ts - a.ts
    })

    return flows
  }

  // TODO: Why call it cleanup? This looks confusing. It actually summarize different category flows, i.e., categoryflow:(mac:)?
  async cleanupCategoryActivity(options, categories) {
    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    if (options.mac) {
      log.debug(`Cleaning up category activities between ${beginString} and ${endString} for device ${options.mac}`)
    } else {
      log.debug(`Cleaning up category activities between ${beginString} and ${endString}`)
    }

    try {

      if (options.skipIfExists) {
        let exists = await flowAggrTool.cleanedCategoryKeyExists(begin, end, options)
        if (exists) {
          return
        }
      }

      let allFlows = {}

      for (const category of categories) {
        let flows = await this.getCategoryFlow(category, options)
        if (flows.length > 0) {
          allFlows[category] = flows
        }
      }

      // allFlows now contains all raw category activities during this range

      let hashCache = {}

      if (Object.keys(allFlows).length > 0) {
        await flowAggrTool.setCleanedCategoryActivity(begin, end, allFlows, options)

        // change after store
        flowUtil.hashIntelFlows(allFlows, hashCache);
        await bone.flowgraphAsync('summarizeActivity', allFlows);
//        let unhashedData = flowUtil.unhashIntelFlows(data, hashCache)
      } else {
        await flowAggrTool.setCleanedCategoryActivity(begin, end, {}, options) // if no data, set an empty {}
      }
    } catch (err) {
      log.error(`Failed to clean category activity: `, err);
    }
  }

}

module.exports = FlowAggregationSensor;
