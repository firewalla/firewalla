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

let instance = null;

function toInt(n){ return Math.floor(Number(n)); };

class FlowAggrTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  getFlowKey(mac, trafficDirection, interval, ts) {
    return util.format("aggrflow:%s:%s:%s:%s", mac, trafficDirection, interval, ts);
  }
  
  // aggrflow:<device_mac>:download:10m:<ts>
  flowExists(mac, trafficDirection, interval, ts) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.keysAsync(key)
      .then((results) => {
        return results.length === 1;
      })
  }

  // key: aggrflow:<device_mac>:<direction>:<interval>:<ts>
  // content: destination ip address
  // score: traffic size
  addFlow(mac, trafficDirection, interval, ts, destIP, traffic) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.zaddAsync(key, traffic, destIP);
  }

  addFlows(mac, trafficDirection, interval, ts, traffics) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    let args = [key];

    for(let destIP in traffics) {
      let traffic = (traffics[destIP] && traffics[destIP][trafficDirection]) || 0;
      args.push(traffic)
      args.push(destIP)
    }

    args.push(0);
    args.push("_"); // placeholder to keep key exists

    return rclient.zaddAsync(args)
      .then(() => {
      return rclient.expireAsync(key, 48 * 3600) // 48 hours
      });
  }
  
  removeFlow(mac, trafficDirection, interval, ts, destIP) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.zremAsync(key, destIP);
  }

  removeFlowKey(mac, trafficDirection, interval, ts) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.delAsync(key);
  }

  getFlowTrafficByDestIP(mac, trafficDirection, interval, ts, destIP) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.zscoreAsync(key, destIP);
  }
  
  getIntervalTick(ts, interval) {
    let i = toInt(interval);
    return toInt(ts / i) * i;
  }
}


module.exports = FlowAggrTool;