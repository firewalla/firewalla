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

const flowTool = require('../../net2/FlowTool.js');

const IntelTool = require('../../net2/IntelTool');
const intelTool = new IntelTool();
const { generateStrictDateTs } = require('../../util/util.js');
const f = require('../../net2/Firewalla.js');

class Tracking {
  constructor() {
    if (instance === null) {
      this.expireInterval = 3600 * 2; // two hours;
      this.bucketInterval = 5 * 60 * 1000; // every 5 mins
      this.maxBuckets = 288;
      this.maxAggrBuckets = 288;
      this.maxResultAggrBuckets = 576; // 2 days
      this.bucketCountPerAggr = 12;
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
  
  getAggregateTrafficKey(mac) {
    return `tracking:aggr:traffic:${mac}`;
  }
  
  getAggregateDestinationCountKey(mac) {
    return `tracking:aggr:dest:${mac}`;
  }

  getAggregateResultKey(mac) {
    return `tracking:aggr:result:${mac}`;
  }
  
  // begin/end is js epoch time
  getBuckets(begin, end) {
    if(begin > end) {
      return [];
    }
    
    let beginBucket = Math.floor(begin / this.bucketInterval);
    let endBucket = Math.floor(end / this.bucketInterval);
    if(endBucket - beginBucket > this.maxBuckets || endBucket < beginBucket) {
      log.debug("Invalid bucket setup, skipped:", beginBucket, endBucket);
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
    await rclient.incrbyAsync(key, Math.floor(traffic));
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
    if (!f.isDevelopmentVersion()) return;
    for(const flow of flows) {
      const destIP = flowTool.getDestIP(flow);
      const intel = await intelTool.getIntel(destIP);
      if(intel && intel.b) { // ignore background traffic
        continue;
      }
      const begin = flow.ts * 1000;
      const end = flow.ets * 1000;
      await this.recordDestination(mac, destIP, begin, end);
      await this.recordTraffic(mac, flow, begin, end);
    }
  }
  
  // aggr the last 24 hours data, this is only for debugging purpose.
  async aggrLast24Hours(mac) {
    return this._aggr(mac, 24 * 3600 * 1000);
  }
  
  async aggr(mac) {
    return this._aggr(mac, this.bucketCountPerAggr * this.bucketInterval);
  }
  
  async _aggr(mac, interval) {
    const buckets = this.getBuckets(new Date() - interval, new Date());
    if (buckets.length !== 2) {
      return;
    }
    
    let results = {};
    
    // traffic
    const aggrTrafficKey = this.getAggregateTrafficKey(mac);
    for(let b = buckets[0]; b <= buckets[1]; b++) {
      const key = this.getTrafficKey(mac, b);
      const x = await rclient.getAsync(key) || 0;

      if(f.isDevelopmentVersion() && x != 0) { // no need to record if value is 0, to save memory usage
        await rclient.hsetAsync(aggrTrafficKey, b, x);
      }

      if (x > 50 * 1000) { // hard code, 50k
        results[b] = 1;
      }
    }
    
    // count
    const aggrDestKey = this.getAggregateDestinationCountKey(mac);
    for(let b = buckets[0]; b <= buckets[1]; b++) {
      const key = this.getDestinationKey(mac, b);
      const x = await rclient.scardAsync(key) || 0;

      if(f.isDevelopmentVersion() && x != 0) { // no need to record if value is 0, to save memory usage
        await rclient.hsetAsync(aggrDestKey, b, x);
      }
      
      if (x > 5) { // hard code, 5 conns
        results[b] = 1;
      }
    }
    
    const aggrResultKey = this.getAggregateResultKey(mac);
    for(let b = buckets[0]; b <= buckets[1]; b++) {
      if (results[b]) {
        await rclient.hsetAsync(aggrResultKey, b, 1);
      } else {
        // no need to record if value is 0, to save memory usage
        // await rclient.hsetAsync(aggrResultKey, b, 0);
      }
    }
  }
  
  async _cleanup(hashKey, expireBucketIndex) {
    const keys = await rclient.hkeysAsync(hashKey);
    let count = 0;
    for(const key of keys) {
      if(key < expireBucketIndex) {
        count ++;
        await rclient.hdelAsync(hashKey, key);
      }
    }
    log.debug("Cleaned up", count, "old aggr data for key", keys);
  }
  
  async cleanup(mac) {
    const buckets = this.getBuckets(new Date() - this.maxAggrBuckets * this.bucketInterval, new Date());
    if (buckets.length !== 2) {
      return;
    }
    
    await this._cleanup(this.getAggregateTrafficKey(mac), buckets[0]);
    await this._cleanup(this.getAggregateDestinationCountKey(mac), buckets[0]);
    await this._cleanup(this.getAggregateResultKey(mac), buckets[0] - 576); // 576 => two more days
  }
  
  async getDistribution(mac, time) {
    time = time || Math.floor(new Date() / 1);
    const d = new Date();
    const offset = d.getTimezoneOffset(); // in mins
    
    const timeWithTimezoneOffset = time - offset * 60 * 1000;
    const beginOfDate = Math.floor(timeWithTimezoneOffset / 1000 / 3600 / 24) * 3600 * 24 * 1000;
    const beginOfDateWithTimezoneOffset = beginOfDate + offset * 60 * 1000;    
    const beginBucket = Math.floor(beginOfDateWithTimezoneOffset / this.bucketInterval);
    const endBucket = beginBucket + this.maxBuckets;
    
    const key = this.getAggregateResultKey(mac);
    const results = await rclient.hgetallAsync(key);
    if (!results) return [];
    let distribution = [];
    
    for(let i = beginBucket; i < endBucket; i++) {      
      distribution.push([i * this.bucketInterval, results[i] === '1' ? 1 : 0]);
    }
    
    return distribution;
  }
  
  async getUsedTime(mac, begin, end) {
    if (!begin) {
      const { beginTs, endTs } = generateStrictDateTs();
      begin = beginTs;
      end = endTs;
    }
    const beginBucket = Math.floor(begin / this.bucketInterval);
    const endBucket = Math.floor(end / this.bucketInterval);
    
    const key = this.getAggregateResultKey(mac);
    const results = await rclient.hgetallAsync(key);
    if (!results) return 0;
    let count = 0;
    for(let i = beginBucket; i < endBucket; i++) {
      if(results[i] === '1') {
        if(i == beginBucket || i == endBucket - 1 ) {
          count += Math.floor(this.bucketInterval / 1000 / 60); // 5 mins by default  
        } else if(results[i-1] === '1' || results[i+1] === '1') {
            count += Math.floor(this.bucketInterval / 1000 / 60); // 5 mins by default
        }
      }
    }
    return count;
  }    
}

module.exports = new Tracking();