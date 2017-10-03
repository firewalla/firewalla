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

let sem = require('../sensor/SensorEventManager.js').getInstance();

let Sensor = require('./Sensor.js').Sensor;

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

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

function toFloorInt(n){ return Math.floor(Number(n)); };

// This sensor is to aggregate device's flow every 10 minutes

// redis key to store the aggr result is redis zset aggrflow:<device_mac>:download:10m:<ts>

class FlowAggregationSensor extends Sensor {
  constructor() {
    super();
    this.config.interval = 600; // default 10 minutes, might be overwrote by net2/config.json
    this.config.cleanupInterval = 60 * 60 // default one hour
    this.config.flowRange = 24 * 3600 // 24 hours
    this.config.sumFlowExpireTime = 2 * 3600 // 2 hours
    this.config.aggrFlowExpireTime = 24 * 3600 // 24 hours
  }

  scheduledJob() {
    log.info("Generating summarized flows info...")
    return async(() => {
      let ts = new Date() / 1000 - 180; // 3 minutes ago
      await (this.aggrAll(ts));
      await (this.sumAll(ts));
      await (this.updateAllHourlySummedFlows(ts));
      log.info("Summarized flow generation is complete");
    })();
  }

  cleanupJob() {
    log.info("Cleaning up app/category flows...")
    return async(() => {
      await (appFlowTool.cleanupAppFlow())
      await (categoryFlowTool.cleanupCategoryFlow())
    })()
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

  trafficGroupByX(flows, x) {
    let traffic = {};

    return async(() => {

      flows.forEach((flow) => {
        let destIP = flowTool.getDestIP(flow);
        let intel = await (intelTool.getIntel(destIP));

        // skip if no app or category intel
        if(!(intel && (intel.app || intel.category)))
          return;

        let appInfos = [];

        if(intel[x])
          appInfos.push(intel[x])

        appInfos.forEach((app) => {
          let t = traffic[app];

          if(typeof t === 'undefined') {
            traffic[app] = {
              duration: 0,
              ts: new Date() / 100,
              download: 0,
              upload: 0
            };
            t = traffic[app];
          }

          // FIXME: Should have more accurate calculation here
          t.duration = Math.max(flow.du, t.duration || 0)
          t.ts = Math.min(flow.ts, t.ts || new Date() / 1000)
          t.download += flow.rb || 0
          t.upload += flow.ob || 0
        })
      });

      return traffic;
    })();
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

      if(typeof t === 'undefined') {
        traffic[destIP] = {upload: 0, download: 0};
        t = traffic[destIP];
      }

      t.upload += flowTool.getUploadTraffic(flow);
      t.download += flowTool.getDownloadTraffic(flow);

    });

    return traffic;
  }

  aggrAll(ts) {
    let now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      return Promise.reject(new Error("aggregation too soon"));
    }

    return async(() => {
      let macs = this.getQualifiedDevices();
      macs.forEach((mac) => {
        await (this.aggr(mac, ts));
        await (this.aggrActivity(mac, ts));
      })
    })();
  }

  // return a list of mac addresses that's active in last xx days
  getQualifiedDevices() {
    return hostManager.hosts.all.map(h => h.o.mac).filter(mac => mac != null);
  }

  // this will be periodically called to update the summed flows in last 24 hours
  // for hours between -24 to -2, if any of these flows are created already, don't update
  // for the last hour, it will periodically update every 10 minutes;
  updateAllHourlySummedFlows(ts) {
    // let now = Math.floor(new Date() / 1000);
    let now = ts; // actually it's NOT now, typically it's 3 mins earlier than NOW;
    let lastHourTick = Math.floor(now / 3600) * 3600;

    return async(() => {

      // the 24th last hours -> the 2nd last hour
      for(let i = 1; i < 24; i++) {
        let ts = lastHourTick - i * 3600;
        await (this.hourlySummedFlows(ts, {
          skipIfExists: true
        }));
      }

      // last hour and this hour
      for(let i = -1; i < 1; i++) {
        let ts = lastHourTick - i * 3600;
        await (this.hourlySummedFlows(ts, {
          skipIfExists: false
        }));
      }
    })();

  }

  // sum all traffic together, across devices
  hourlySummedFlows(ts, options) {
    // ts is the end timestamp of the hour
    ts = Math.floor(ts / 3600) * 3600
    let end = ts;
    let begin = end - 3600;
    let skipIfExists = options && options.skipIfExists;

    return async(() => {
      let options = {
        begin: begin,
        end: end,
        interval: this.config.interval,
        expireTime: 24 * 3600, // keep for 36 hours
        skipIfExists: skipIfExists
      }

      await (flowAggrTool.addSumFlow("download", options));
      await (flowAggrTool.addSumFlow("upload", options));
      await (flowAggrTool.addSumFlow("app", options));

    })();
  }

  sumAll(ts) {
    let now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      return Promise.reject(new Error("sum too soon"));
    }

    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.flowRange;


    return async(() => {
      let options = {
        begin: begin,
        end: end,
        interval: this.config.interval,
        expireTime: this.config.sumFlowExpireTime,
      }

      let macs = this.getQualifiedDevices();
      macs.forEach((mac) => {
        options.mac = mac;
        await (flowAggrTool.addSumFlow("download", options));
        await (flowAggrTool.addSumFlow("upload", options));
        await (flowAggrTool.addSumFlow("app", options));
        await (flowAggrTool.addSumFlow("category", options));
      })
    })();
  }

  _flowHasActivity(flow, cache) {
    cache = cache || {}

    let destIP = flowTool.getDestIP(flow);

    if(cache && cache[destIP] === 0) {
      return false;
    }

    if(cache && cache[destIP] === 1) {
      return true;
    }

    return async(() => {
      let intel = await (intelTool.getIntel(destIP));
      if(intel == null ||
        (!intel.app && !intel.category)) {
        cache[destIP] = 0;
        return false;
      } else {
        cache[destIP] = 1;
        return true;
      }
    })();
  }

  aggrActivity(macAddress, ts) {
    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.interval;

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    let msg = util.format("Aggregating %s activities between %s and %s", macAddress, beginString, endString)
    log.debug(msg);

    return async(() => {
      let ips = await (hostTool.getIPsByMac(macAddress));

      let flows = [];

      ips.forEach((ip) => {
        let cache = {};

        let outgoingFlows = await (flowTool.queryFlows(ip, "in", begin, end)); // in => outgoing
        let outgoingFlowsHavingIntels = outgoingFlows.filter((f) => {
          return await (this._flowHasActivity(f, cache));
        });
        flows.push.apply(flows, outgoingFlowsHavingIntels);

        let incomingFlows = await (flowTool.queryFlows(ip, "out", begin, end)); // out => incoming
        let incomingFlowsHavingIntels = incomingFlows.filter((f) => {
          return await (this._flowHasActivity(f, cache));
        });
        flows.push.apply(flows, incomingFlowsHavingIntels);
      });

      // now flows array should only contain flows having intels

      // record app/category flows by duration
      let appTraffic = await (this.trafficGroupByApp(flows));
      await (flowAggrTool.addAppActivityFlows(macAddress, this.config.interval, end, appTraffic, this.config.aggrFlowExpireTime));

      let categoryTraffic = await (this.trafficGroupByCategory(flows))
      await (flowAggrTool.addCategoryActivityFlows(macAddress, this.config.interval, end, categoryTraffic, this.config.aggrFlowExpireTime));

      // record detail app/category flows by upload/download/ts/duration

      await(this.recordApp(macAddress, appTraffic))
      await(this.recordCategory(macAddress, categoryTraffic))

    })();
  }

  recordApp(mac, traffic) {
    return async(() => {
      for(let app in traffic) {
        let object = traffic[app]
        await (appFlowTool.addAppFlowObject(mac, app, object))
      }
    })()
  }

  recordCategory(mac, traffic) {
    return async(() => {
      for(let category in traffic) {
        let object = traffic[category]
        await (categoryFlowTool.addCategoryFlowObject(mac, category, object))
      }
    })()
  }

  aggr(macAddress, ts) {
    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.interval;

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    let msg = util.format("Aggregating %s flows between %s and %s", macAddress, beginString, endString)
    log.info(msg);

    return async(() => {
      let ips = await (hostTool.getIPsByMac(macAddress));

      let flows = [];

      ips.forEach((ip) => {
        let outgoingFlows = await (flowTool.queryFlows(ip, "in", begin, end)); // in => outgoing
        flows.push.apply(flows, outgoingFlows);
        let incomingFlows = await (flowTool.queryFlows(ip, "out", begin, end)); // out => incoming
        flows.push.apply(flows, incomingFlows);
      });

      let traffic = this.trafficGroupByDestIP(flows);

      await (flowAggrTool.addFlows(macAddress, "upload", this.config.interval, end, traffic, this.config.aggrFlowExpireTime));
      await (flowAggrTool.addFlows(macAddress, "download", this.config.interval, end, traffic, this.config.aggrFlowExpireTime));

    })();
  }

}

module.exports = FlowAggregationSensor;
