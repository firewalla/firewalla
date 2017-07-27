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

let HostTool = require('../net2/HostTool')
let hostTool = new HostTool();

function toFloorInt(n){ return Math.floor(Number(n)); };

// This sensor is to aggregate device's flow every 10 minutes

// redis key to store the aggr result is redis zset aggrflow:<device_mac>:download:10m:<ts>

class FlowAggregationSensor extends Sensor {
  constructor() {
    super();
    this.config.interval = 600; // default 10 minutes, might be overwrote by net2/config.json
    this.config.flowRange = 24 * 3600 // 24 hours
  }
  
  run() {
    let ts = new Date() / 1000 - 180; // 3 minutes ago
    process.nextTick(() => this.aggrAll(ts));
    process.nextTick(() => this.sumAll(ts));
    
    // TODO: Need to ensure all ticks will be processed and stored in redis
    setInterval(() => {
      this.aggrAll(ts);
      this.sumAll(ts);
    }, this.config.interval * 1000);
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
      let macs = await (hostTool.getAllMACs());
      macs.forEach((mac) => {
        this.aggr(mac, ts);
      })
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
    
    let end = flowAggrTool.getIntervalTick(ts);
    let begin = end - this.config.flowRange;
    

    return async(() => {
      let macs = await (hostTool.getAllMACs());
      macs.forEach((mac) => {
        await (flowAggrTool.addSumFlow(mac, "download", begin, end, this.config.interval));
        await (flowAggrTool.addSumFlow(mac, "upload", begin, end, this.config.interval));
      })
    })();
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

      await (flowAggrTool.addFlows(macAddress, "upload", this.config.interval, end, traffic));
      await (flowAggrTool.addFlows(macAddress, "download", this.config.interval, end, traffic));

    })();
  }

}

module.exports = FlowAggregationSensor;

