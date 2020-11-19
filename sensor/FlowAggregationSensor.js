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
const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);

const util = require('util');

const Sensor = require('./Sensor.js').Sensor;

const flowTool = require('../net2/FlowTool')();
const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();

const TypeFlowTool = require('../flow/TypeFlowTool.js')
const appFlowTool = new TypeFlowTool('app')
const categoryFlowTool = new TypeFlowTool('category')

const HostTool = require('../net2/HostTool')
const hostTool = new HostTool();

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const flowUtil = require('../net2/FlowUtil')

const config = require('../net2/config.js').getConfig();
const excludedCategories = (config.category && config.category.exclude) || [];

const sem = require('../sensor/SensorEventManager.js').getInstance();

const platform = require('../platform/PlatformLoader.js').getPlatform();

const al = require('../util/accountingAudit.js');

const f = require('../net2/Firewalla.js');

// This sensor is to aggregate device's flow every 10 minutes

// redis key to store the aggr result is redis zset aggrflow:<device_mac>:download:10m:<ts>

const accounting = require('../extension/accounting/accounting.js');

class FlowAggregationSensor extends Sensor {
  constructor() {
    super();
    this.firstTime = true; // some work only need to be done once, use this flag to check
    this.retentionTimeMultipler = platform.getRetentionTimeMultiplier();
    this.retentionCountMultipler = platform.getRetentionCountMultiplier();
  }

  async scheduledJob() {
    log.info("Generating summarized flows info...")

    let ts = new Date() / 1000 - 90; // checkpoint time is set to 90 seconds ago
    await this.aggrAll(ts)

    // preload apps and categories to improve performance
    const apps = await appFlowTool.getTypes('*'); // all mac addresses
    const categories = await categoryFlowTool.getTypes('*') // all mac addresses

    await this.sumFlowRange(ts, apps, categories)
    await this.updateAllHourlySummedFlows(ts, apps, categories)
    /* todo
    const periods = platform.sumPeriods()
    for(const period  of periods){
       period => last 24  use 10 mins aggr
       period => daily    use houlry sum
       period => weekly   use daily sum
    }
    */
    this.firstTime = false;
    log.info("Summarized flow generation is complete");
  }

  run() {
    this.config.sumFlowExpireTime *= this.retentionTimeMultipler;
    this.config.sumFlowMaxFlow *= this.retentionCountMultipler;
    log.debug("config.interval="+ this.config.interval);
    log.debug("config.flowRange="+ this.config.flowRange);
    log.debug("config.sumFlowExpireTime="+ this.config.sumFlowExpireTime);
    log.debug("config.aggrFlowExpireTime="+ this.config.aggrFlowExpireTime); // aggrFlowExpireTime shoud be same as flowRange or bigger
    log.debug("config.sumFlowMaxFlow="+ this.config.sumFlowMaxFlow);
    sem.once('IPTABLES_READY', async () => {
      // init host
      if (hostManager.hosts.all.length == 0) {
        await hostManager.getHostsAsync();
      }

      process.nextTick(() => {
        this.scheduledJob();
      });

      // TODO: Need to ensure all ticks will be processed and stored in redis
      setInterval(() => {
        this.scheduledJob();
      }, this.config.interval * 1000)

    });
  }

  async accountTrafficByX(mac, flows) {
    let traffic = {};

    for (const flow of flows) {
      let destIP = flowTool.getDestIP(flow);
      let intel = await intelTool.getIntel(destIP);

      // skip if no app or category intel
      if(!(intel && (intel.app || intel.category)))
        return;

      if(!intel.a) { // a new field a to indicate accounting
        return;
      }

      if (intel.app) {
        await accounting.record(mac, intel.app, flow.ts * 1000, flow.ets * 1000);
        if(f.isDevelopmentVersion()) {
          al("app", intel.app, mac, intel.host, destIP);
        }
      }

      if (intel.category && !excludedCategories.includes(intel.category)) {
        await accounting.record(mac, intel.category, flow.ts * 1000, flow.ets * 1000);
        if(f.isDevelopmentVersion()) {
          al("category", intel.category, mac, intel.host, destIP);
        }
      }
    }
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
    const hourlySteps = 24; // houlry steps should be consistent with aggrFlowExpireTime

    if (this.firstTime) {
      // the 24th last hours -> the 2nd last hour
      for (let i = 1; i < hourlySteps; i++) {
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
    const end = ts;
    const begin = end - 3600;
    const skipIfExists = opts && opts.skipIfExists;

    const endString = new Date(end * 1000).toLocaleTimeString();
    const beginString = new Date(begin * 1000).toLocaleTimeString();
    log.debug(`Aggregating hourly flows for ${beginString} - ${endString}, skipIfExists flag: ${skipIfExists}`)

    const options = {
      begin: begin,
      end: end,
      interval: this.config.interval,
      expireTime: this.config.sumFlowExpireTime, // hourly sumflow retention time should be blue/red 24hours, navy/gold 72hours
      skipIfExists: skipIfExists,
      max_flow: 200
    }


    await this.sumViews(options, apps, categories)
  }

  async sumViews(options, apps, categories) {
    await flowAggrTool.addSumFlow("download", options);
    await flowAggrTool.addSumFlow("upload", options);
    await flowAggrTool.addSumFlow("app", options);
    await this.summarizeActivity(options, 'app', apps); // to filter idle activities
    await flowAggrTool.addSumFlow("category", options);
    await this.summarizeActivity(options, 'category', categories);

    // aggregate intf
    const intfs = hostManager.getActiveIntfs();
    log.debug(`sumViews intfs:`, intfs);

    for (const intf of intfs) {
      if(!intf || _.isEmpty(intf.macs)) {
        return;
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));

      optionsCopy.intf = intf.intf;
      optionsCopy.macs = intf.macs;
      await flowAggrTool.addSumFlow("download", optionsCopy);
      await flowAggrTool.addSumFlow("upload", optionsCopy);
      await flowAggrTool.addSumFlow("app", optionsCopy);
      await this.summarizeActivity(optionsCopy, 'app', apps); // to filter idle activities if updated
      await flowAggrTool.addSumFlow("category", optionsCopy);
      await this.summarizeActivity(optionsCopy, 'category', categories);
    }

    // aggregate tags
    const tags = hostManager.getActiveTags();
    log.debug(`sumViews tags:`, tags);

    for (const tag of tags) {
      if(!tag || _.isEmpty(tag.macs)) {
        return;
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));

      optionsCopy.tag = tag.tag;
      optionsCopy.macs = tag.macs;
      await flowAggrTool.addSumFlow("download", optionsCopy);
      await flowAggrTool.addSumFlow("upload", optionsCopy);
      await flowAggrTool.addSumFlow("app", optionsCopy);
      await this.summarizeActivity(optionsCopy, 'app', apps); // to filter idle activities if updated
      await flowAggrTool.addSumFlow("category", optionsCopy);
      await this.summarizeActivity(optionsCopy, 'category', categories);
    }

    // aggregate all
    const macs = hostManager.getActiveMACs();

    for (const mac of macs) {
      if(!mac) {
        return
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));

      optionsCopy.mac = mac
      await flowAggrTool.addSumFlow("download", optionsCopy);
      await flowAggrTool.addSumFlow("upload", optionsCopy);
      await flowAggrTool.addSumFlow("app", optionsCopy);
      await this.summarizeActivity(optionsCopy, 'app', apps); // to filter idle activities if updated
      await flowAggrTool.addSumFlow("category", optionsCopy);
      await this.summarizeActivity(optionsCopy, 'category', categories);
    }
  }

  async sumFlowRange(ts, apps, categories) {
    const now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      throw new Error("sum too soon")
    }

    const end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    const begin = end - this.config.flowRange;


    const options = {
      begin: begin,
      end: end,
      interval: this.config.interval,
      // if working properly, flowaggregation sensor run every 10 mins
      // last 24 hours sum flows will generate every 10 mins
      // make sure expireTime greater than 10 mins and expire key to reduce memonry usage, differnet with hourly sum flows should retention
      expireTime: 24 * 60,
      setLastSumFlow: true,
      max_flow: this.config.sumFlowMaxFlow
    }

    await this.sumViews(options, apps, categories)
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
    // TODO: add recording for network/group/global as well
    await this.accountTrafficByX(macAddress, flows);

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
      await appFlowTool.addTypeFlowObject(mac, app, object)
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
      await categoryFlowTool.addTypeFlowObject(mac, category, object)
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

  async getFlow(dimension, type, options) {
    let flows = []

    let macs = []

    if (options.intf || options.tag) {
      macs = options.macs;
    } else if (options.mac) {
      macs = [options.mac]
    } else {
      macs = hostManager.getActiveMACs()
    }


    const typeFlowTool = new TypeFlowTool(dimension)
    const getTypeFlow = typeFlowTool.getTypeFlow.bind(typeFlowTool)

    for (const mac of macs) {
      let typeFlows = await getTypeFlow(mac, type, options)
      typeFlows = typeFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
      typeFlows.forEach((f) => {
        f.device = mac
      })

      flows.push.apply(flows, typeFlows)
    }

    flows.sort((a, b) => {
      return b.ts - a.ts
    })

    return flows
  }

  async summarizeActivity(options, dimension, types) {
    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    if (options.intf) {
      log.debug(`Cleaning up ${dimension} activities between ${beginString} and ${endString} for intf`, options.intf);
    } else if (options.tag) {
      log.debug(`Cleaning up ${dimension} activities between ${beginString} and ${endString} for tag`, options.tag);
    } if(options.mac) {
      log.debug(`Cleaning up ${dimension} activities between ${beginString} and ${endString} for device ${options.mac}`);
    } else {
      log.debug(`Cleaning up ${dimension} activities between ${beginString} and ${endString}`);
    }

    try {
      if(options.skipIfExists) {
        let exists = await flowAggrTool.cleanedAppKeyExists(begin, end, options)
        if(exists) {
          return
        }
      }

      let allFlows = {}

      for (const type of types) {
        let flows = await this.getFlow(dimension, type, options)
        if(flows.length > 0) {
          allFlows[type] = flows
        }
      }

      // allFlows now contains all raw app activities during this range

      let hashCache = {}

      if(Object.keys(allFlows).length > 0) {
        await flowAggrTool.setCleanedAppActivity(begin, end, allFlows, options)

        // change after store
        flowUtil.hashIntelFlows(allFlows, hashCache)
//        await bone.flowgraphAsync('summarizeApp', allFlows)
//        let unhashedData = flowUtil.unhashIntelFlows(data, hashCache)
      } else {
        await flowAggrTool.setCleanedAppActivity(begin, end, {}, options) // if no data, set an empty {}
      }
    } catch(err) {
      log.error(`Failed to summarize ${dimension} activity: `, err);
    }
  }
}

module.exports = FlowAggregationSensor;
