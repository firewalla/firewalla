/*    Copyright 2020 Firewalla INC.
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

let instance = null;

const rclient = require('../../util/redis_manager.js').getRedisClient()
const log = require('../../net2/logger.js')(__filename);

const flowTool = require('../../net2/FlowTool.js')();

const _ = require('lodash');

class Tracking {
  constructor() {
    if (instance === null) {
      this.expireInterval = 3600 * 24; // one hour, use 24 hours temporarily 
      this.bucketInterval = 5 * 60 * 1000; // every 5 mins
      this.maxBuckets = 288;
      this.maxItemsInBucket = 100;
      this.resetOffset = 0; // local timezone, starting from 0 O'Clock
      instance = this;
    }
    
    return instance;
  }

  // each buckets represents 5 min activities
  // this key is a set of unique IP/domains
  getDestinationKey(mac, bucket) {
    return `tracking:dest:${mac}:${bucket}`;
  }
  
  getTrafficKey(mac, bucket) {
    return `tracking:traffic:${mac}:${bucket}`;
  }
  
  // begin/end is js epoch time
  getBuckets(begin, end) {
    if(begin > end) {
      return [];
    }
    
    let buckets = [];
    let beginBucket = Math.floor(begin / this.bucketInterval);
    let endBucket = Math.floor(end / this.bucketInterval);
    if(endBucket - beginBucket > this.maxBuckets || endBucket < beginBucket) {
      log.info("Invalid bucket setup, skipped:", beginBucket, endBucket);
      return [];
    }
    return [beginBucket, endBucket];
  }
  
  async appendDestination(key, destination) {
    const size = await rclient.scardAsync(key);
    if (size >= this.maxItemsInBucket) {
      return;
    }
    
    await rclient.saddAsync(key, destination);
    await rclient.expireAsync(key, this.expireInterval);
  }
  
  async appendTraffic(key, traffic) {
    await rclient.incrAsync(key, Math.floor(traffic));
    await rclient.expireAsync(key, this.expireInterval);    
  }
  
  // begin, end - timestamps
  async recordDestination(mac, destination, begin, end) {
    const buckets = this.getBuckets(begin, end);
    if (buckets.length !== 2) {
      return;
    }
    
    for (let b = buckets[0]; b <= buckets[1]; b++) {
      const key = this.getDestinationKey(mac, b);
      await this.appendDestination(key, destination);
    }      
  }
  
  async recordTraffic(mac, flow, begin, end) {
    const buckets = this.getBuckets(begin, end);
    if (buckets.length !== 2) {
      return;
    }
    
    for (let b = buckets[0]; b <= buckets[1]; b++) {
      const trafficKey = this.getTrafficKey(mac, b);
      const duration = flow.du;
      const traffic = flow.ob + flow.rb;
      
      // FIXME: may need to be more accurate
      if (duration < this.bucketInterval / 1000) {
        await this.appendTraffic(trafficKey, traffic);
      } else {
        await this.appendTraffic(trafficKey, traffic * this.bucketInterval / 1000 / duration);
      }
    }      
  }
  
  async recordFlows(mac, flows) {
    for(const flow of flows) {
      const destIP = flowTool.getDestIP(flow);
      const begin = flow.ts * 1000;
      const end = flow.ets * 1000;
      await this.recordDestination(mac, destIP, begin, end);
      await this.recordTraffic(mac, flow, begin, end);
    }
  }
}

module.exports = new Tracking();