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

const rclient = require('../util/redis_manager.js').getRedisClient()

const util = require('util');

const _ = require('lodash')

let instance = null;

const MAX_FLOW_PER_AGGR = 2000
const MAX_FLOW_PER_SUM = 30000
const MAX_FLOW_PER_HOUR = 7000

const MIN_AGGR_TRAFFIC = 256
const MIN_SUM_TRAFFIC = 1024

function toInt(n){ return Math.floor(Number(n)); };

class FlowAggrTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  toFloorInt(n) {
    return toInt(n);
  }

  getFlowKey(mac, trafficDirection, interval, ts) {
    return util.format("aggrflow:%s:%s:%s:%s", mac, trafficDirection, interval, ts);
  }

  getSumFlowKey(mac, trafficDirection, begin, end) {
    if(mac) {
      return util.format("sumflow:%s:%s:%s:%s", mac, trafficDirection, begin, end);
    } else {
      return util.format("syssumflow:%s:%s:%s", trafficDirection, begin, end);
    }
  }

  // aggrflow:<device_mac>:download:10m:<ts>
  async flowExists(mac, trafficDirection, interval, ts) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    const results = await rclient.existsAsync(key)
    return results == 1
  }

  // key: aggrflow:<device_mac>:<direction>:<interval>:<ts>
  // content: destination ip address
  // score: traffic size
  addFlow(mac, trafficDirection, interval, ts, destIP, traffic) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.zaddAsync(key, traffic, destIP);
  }

  addAppActivityFlows(mac, interval, ts, traffics, expire) {
    return this.addXActivityFlows(mac, "app", interval, ts, traffics, expire)
  }

  addCategoryActivityFlows(mac, interval, ts, traffics, expire) {
    return this.addXActivityFlows(mac, "category", interval, ts, traffics, expire)
  }

  async addXActivityFlows(mac, x, interval, ts, traffics, expire) {
    expire = expire || 24 * 3600; // by default keep 24 hours

    let key = this.getFlowKey(mac, x, interval, ts);
    let args = [key];
    for(let t in traffics) {
      let duration = (traffics[t] && traffics[t]['duration']) || 0;
      args.push(duration)

      let payload = {}
      payload.device = mac
      payload[x] = t
      args.push(JSON.stringify(payload))
    }

    args.push(0);
    args.push("_"); // placeholder to keep key exists

    await rclient.zaddAsync(args)
    return rclient.expireAsync(key, expire)
  }

  // this is to make sure flow data is not flooded enough to consume all memory
  async trimFlow(mac, trafficDirection, interval, ts) {
    const key = this.getFlowKey(mac, trafficDirection, interval, ts);

    let count = await rclient.zremrangebyrankAsync(key, 0, -1 * MAX_FLOW_PER_AGGR) // only keep the MAX_FLOW_PER_SUM highest flows
    if(count > 0) {
      log.warn(`${count} flows are removed from ${key} for self protection`)
    }
  }

  async addFlows(mac, trafficDirection, interval, ts, traffics, expire) {
    expire = expire || 24 * 3600; // by default keep 24 hours

    const length = Object.keys(traffics).length // number of dest ips in this aggr flow
    const key = this.getFlowKey(mac, trafficDirection, interval, ts);

    let args = [key];

    if(length > MAX_FLOW_PER_AGGR) { // self protection
      args.push(length)
      args.push(JSON.stringify({
        device: mac,
        destIP: "0.0.0.0"       // special ip address to indicate some flows were skipped due to overflow protection
      }))
    }

    for(let destIP in traffics) {
      let traffic = (traffics[destIP] && traffics[destIP][trafficDirection]) || 0;
      let port = (traffics[destIP] && traffics[destIP].port) || [];

      if(traffic < MIN_AGGR_TRAFFIC) {
        continue                // skip very small traffic
      }

      args.push(traffic)
      args.push(JSON.stringify({
        device: mac,
        destIP: destIP,
        port: port
      }))
    }

    args.push(0);
    args.push("_"); // placeholder to keep key exists
    await rclient.zaddAsync(args)
    await rclient.expireAsync(key, expire)
    await this.trimFlow(mac, trafficDirection, interval, ts)
  }

  removeFlow(mac, trafficDirection, interval, ts, destIP) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.zremAsync(key, destIP);
  }

  removeFlowKey(mac, trafficDirection, interval, ts) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.delAsync(key);
  }

  async removeAllFlowKeys(mac, trafficDirection, interval) {
    let keyPattern =
      !trafficDirection ? util.format("aggrflow:%s:*", mac) :
      !interval         ? util.format("aggrflow:%s:%s:*", mac, trafficDirection) :
                          util.format("aggrflow:%s:%s:%s:*", mac, trafficDirection, interval);

    let keys = await rclient.keysAsync(keyPattern);

    if (keys.length)
      return rclient.delAsync(keys);
    else
      return 0
  }

  // this is to make sure flow data is not flooded enough to consume all memory
  async trimSumFlow(trafficDirection, options) {
    if(!options.begin || !options.end) {
      throw new Error("Require begin and end");
    }

    let begin = options.begin;
    let end = options.end;

    let max_flow = MAX_FLOW_PER_SUM

    if(end-begin < 4000) { // hourly sum
      max_flow = MAX_FLOW_PER_HOUR
    }

    if(options.max_flow) {
      max_flow = options.max_flow
    }

    let mac = options.mac; // if mac is undefined, by default it will scan over all machines

    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    let count = await rclient.zremrangebyrankAsync(sumFlowKey, 0, -1 * max_flow) // only keep the MAX_FLOW_PER_SUM highest flows
    if(count > 0) {
      log.warn(`${count} flows are removed from ${sumFlowKey} for self protection`)
    }
  }

  // sumflow:<device_mac>:download:<begin_ts>:<end_ts>
  // content: destination ip address
  // score: traffic size

  // interval is the interval of each aggr flow (aggrflow:...)
  async addSumFlow(trafficDirection, options) {

    if(!options.begin || !options.end) {
      throw new Error("Require begin and end");
    }

    let begin = options.begin;
    let end = options.end;

    // if working properly, sumflow should be refreshed in every 10 minutes
    let expire = options.expireTime || 24 * 60; // by default expire in 24 minutes
    let interval = options.interval || 600; // by default 10 mins

    let mac = options.mac; // if mac is undefined, by default it will scan over all machines

    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    if(options.skipIfExists) {
      let exists = await rclient.existsAsync(sumFlowKey);
      if(exists) {
        return;
      }
    }

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    if(mac) {
      log.debug(util.format("Summing %s %s flows between %s and %s", mac, trafficDirection, beginString, endString));
    } else {
      log.debug(util.format("Summing all %s flows in the network between %s and %s", trafficDirection, beginString, endString));
    }

    let ticks = this.getTicks(begin, end, interval);
    let tickKeys = null

    if(mac) {
      tickKeys = ticks.map((tick) => this.getFlowKey(mac, trafficDirection, interval, tick));
    } else {
      // only call keys once to improve performance
      const keyPattern = this.getFlowKey('*', trafficDirection, interval, '*');
      const matchedKeys = await rclient.keysAsync(keyPattern);

      tickKeys = matchedKeys.filter((key) => {
        return ticks.some((tick) => key.endsWith(`:${tick}`))
      });
    }

    let num = tickKeys.length;

    if(num <= 0) {
      log.debug("Nothing to sum for key", sumFlowKey);

      // add a placeholder in redis to avoid duplicated queries
      await rclient.zaddAsync(sumFlowKey, 0, '_');
      return;
    }

    // ZUNIONSTORE destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM|MIN|MAX]
    let args = [sumFlowKey, num];
    args.push.apply(args, tickKeys);

    log.debug("zunionstore args: ", args);

    if(options.skipIfExists) {
      let exists = await rclient.keysAsync(sumFlowKey);
      if(exists.length > 0) {
        return;
      }
    }

    let result = await rclient.zunionstoreAsync(args);
    if(result > 0) {
      if(options.setLastSumFlow) {
        await this.setLastSumFlow(mac, trafficDirection, sumFlowKey)
      }
      await rclient.expireAsync(sumFlowKey, expire)
      await this.trimSumFlow(trafficDirection, options)
    }

    return result;
  }

  setLastSumFlow(mac, trafficDirection, keyName) {
    let key = "";
    
    if(mac) {
      key = util.format("lastsumflow:%s:%s", mac, trafficDirection);
    } else {
      key = util.format("lastsumflow:%s", trafficDirection);
    }

    return rclient.setAsync(key, keyName);
  }

  getLastSumFlow(mac, trafficDirection) {
    let key = util.format("lastsumflow:%s:%s", mac, trafficDirection);
    return rclient.getAsync(key);
  }

  getSumFlow(mac, trafficDirection, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    return rclient.zrangeAsync(sumFlowKey, 0, count, 'withscores');
  }

  // return a list of destinations sorted by transfer size desc
  async getTopSumFlowByKeyAndDestination(key, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    const destAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count);
    const results = {};
    const totalPorts = {};

    for(let i = 0; i < destAndScores.length; i++) {
      if(i % 2 === 1) {
        let payload = destAndScores[i-1];
        let count = Number(destAndScores[i]);
        if(payload !== '_' && count !== 0) {
          try {
            const json = JSON.parse(payload);
            const dest = json.destIP;
            const ports = json.port;
            if(!dest) {
              continue;
            }  
            if(results[dest]) {
              results[dest] += count
            } else {
              results[dest] = count
            }

            if(ports) {
              if(totalPorts[dest]) {
                totalPorts[dest].push.apply(totalPorts[dest], ports)
              } else {
                totalPorts[dest] = ports
              }
            }
          } catch(err) {
            log.error("Failed to parse payload: ", payload);
          }
        }
      }
    }

    const array = [];
    for(const destIP in results) {
      let ports = totalPorts[destIP] || [];
      ports = ports.filter((v, i) => {
        return ports.indexOf(v) === i;
      })
      array.push({ip: destIP, count: results[destIP], ports: ports});
    }

    array.sort(function(a, b) {
      return a.count - b.count
    });

    return array;
  }

  async getTopSumFlowByKey(key, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    let destAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count);
    let results = [];
    for(let i = 0; i < destAndScores.length; i++) {
      if(i % 2 === 1) {
        let payload = destAndScores[i-1];
        let count = destAndScores[i];
        if(payload !== '_' && count !== 0) {
          try {
            let json = JSON.parse(payload);
            results.push({ip: json.destIP, device: json.device, count: count,port:json.port});
          } catch(err) {
            log.error("Failed to parse payload: ", payload);
          }
        }
      }
    }
    return results;
  }

  getAppActivitySumFlowByKey(key, count) {
    return this.getXActivitySumFlowByKey(key, 'app', count)
  }

  getCategoryActivitySumFlowByKey(key, count) {
    return this.getXActivitySumFlowByKey(key, 'category', count)
  }

  // group by activity, ignore individual devices
  // return a list of categories sorted by time desc
  async getXYActivitySumFlowByKey(key, xy, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    const appAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count);
    const results = {};

    for(let i = 0; i < appAndScores.length; i++) {
      if(i % 2 === 1) {
        let payload = appAndScores[i-1];
        let count = Number(appAndScores[i]);
        if(payload !== '_' && count !== 0) {
          try {
            let json = JSON.parse(payload);
            const key = json[xy];
            if(!key) {
              continue;
            }            
            if(results[key]) {
              results[key] += count
            } else {
              results[key] = count
            }
          } catch(err) {
            log.error("Failed to parse payload: ", payload);
          }
        }
      }
    }
    
    let array = [];
    for(const category in results) {
      const count = Math.floor(results[category]);
      if(count < 10) {
          continue;
      }
      array.push({category, count});
    }

    array.sort(function(a, b) {
      return a.count - b.count
    });

    return array;
  }

  async getXActivitySumFlowByKey(key, x, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    let appAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count);
    let results = [];
    for(let i = 0; i < appAndScores.length; i++) {
      if(i % 2 === 1) {
        let payload = appAndScores[i-1];
        let count = appAndScores[i];
        if(payload !== '_' && count !== 0) {
          try {
            let json = JSON.parse(payload);
            let result = {}
            result[x] = json[x]
            result.device = json.device
            result.count = count
            results.push(result)
          } catch(err) {
            log.error("Failed to parse payload: ", payload);
          }
        }
      }
    }
    return results;
  }

  getTopSumFlow(mac, trafficDirection, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    return this.getTopSumFlowByKey(sumFlowKey, count);
  }

  async removeAllSumFlows(mac, trafficDirection) {
    let keyPattern = trafficDirection
      ? util.format("sumflow:%s:%s:*", mac, trafficDirection)
      : util.format("sumflow:%s:*", mac);

    let keys = await rclient.keysAsync(keyPattern);

    if (keys.length)
      return rclient.delAsync(keys);
    else
      return 0
  }

  getFlowTrafficByDestIP(mac, trafficDirection, interval, ts, destIP) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);

    // MUST device first, destIP second!!
    return rclient.zscoreAsync(key, JSON.stringify({device:mac, destIP: destIP}));
  }

  async getActivityFlowTrafficByActivity(mac, interval, ts, app) {
    let key = this.getFlowKey(mac, "app", interval, ts);

    return rclient.zscoreAsync(key, JSON.stringify({device:mac, app: app}));
  }

  getIntervalTick(ts, interval) {
    let i = toInt(interval);
    return toInt(ts / i) * i;
  }

  getLargerIntervalTick(ts, interval) {
    let i = toInt(interval);
    return toInt(ts / i) * i + i;
  }

  // Find all the tick points in this range
  getTicks(begin, end, interval) {
    let x = this.getLargerIntervalTick(begin, interval);
    let y = this.getIntervalTick(end, interval);

    let ticks = [];
    for(let i = x; i <= y; i += interval) {
      ticks.push(i);
    }

    return ticks;
  }

  getCleanedAppKey(begin, end, options) {
    if(options.mac) {
      return `app:host:${options.mac}:${begin}:${end}`
    } else {
      return `app:system:${begin}:${end}`
    }
  }

  async cleanedAppKeyExists(begin, end, options) {
    let key = this.getCleanedAppKey(begin, end, options)
    let exists = await rclient.existsAsync(key)
    return exists == 1
  }

  async setCleanedAppActivity(begin, end, data, options) {
    options = options || {}

    let key = this.getCleanedAppKey(begin, end, options)
    let expire = options.expireTime || 24 * 60; // by default expire in 24 minutes
    await rclient.setAsync(key, JSON.stringify(data))
    await rclient.expireAsync(key, expire)
    if(options.mac && options.setLastSumFlow) {
      await this.setLastAppActivity(options.mac, key)
    }
  }

  async getCleanedAppActivityByKey(key, options) {
    options = options || {}

    let dataString = await rclient.getAsync(key)
    if(!dataString) {
      return null
    }

    try {
      let obj = JSON.parse(dataString)
      return obj
    } catch(err) {
      log.error("Failed to parse json:", dataString, "err:", err);
      return null
    }
  }

  getCleanedAppActivity(begin, end, options) {
    options = options || {}

    let key = this.getCleanedAppKey(begin, end, options)
    return this.getCleanedAppActivityByKey(key, options)
  }


  setLastAppActivity(mac, keyName) {
    let key = util.format("lastapp:host:%s", mac);
    return rclient.setAsync(key, keyName);
  }

  getLastAppActivity(mac) {
    let key = util.format("lastapp:host:%s", mac);
    return rclient.getAsync(key);
  }

  getCleanedCategoryKey(begin, end, options) {
    if(options.mac) {
      return `category:host:${options.mac}:${begin}:${end}`
    } else {
      return `category:system:${begin}:${end}`
    }
  }

  async cleanedCategoryKeyExists(begin, end, options) {
    let key = this.getCleanedCategoryKey(begin, end, options)
    let exists = await rclient.existsAsync(key)
    return exists == 1
  }

  async setCleanedCategoryActivity(begin, end, data, options) {
    options = options || {}

    let key = this.getCleanedCategoryKey(begin, end, options)
    let expire = options.expireTime || 24 * 60; // by default expire in 24 minutes
    await rclient.setAsync(key, JSON.stringify(data))
    await rclient.expireAsync(key, expire)

    if(options.mac && options.setLastSumFlow) {
      await this.setLastCategoryActivity(options.mac, key)
    }
  }

  async getCleanedCategoryActivityByKey(key, options) {
    options = options || {}

    let dataString = await rclient.getAsync(key)

    if(!dataString) {
      return null
    }

    try {
      let obj = JSON.parse(dataString)
      return obj
    } catch(err) {
      log.error("Failed to parse json:", dataString, "err:", err);
      return null
    }
  }

  getCleanedCategoryActivity(begin, end, options) {
    options = options || {}
    let key = this.getCleanedCategoryKey(begin, end, options)
    return this.getCleanedCategoryActivityByKey(key, options)
  }

  setLastCategoryActivity(mac, keyName) {
    let key = util.format("lastcategory:host:%s", mac);
    return rclient.setAsync(key, keyName);
  }

  getLastCategoryActivity(mac) {
    let key = util.format("lastcategory:host:%s", mac);
    return rclient.getAsync(key);
  }

  async removeAggrFlowsAll(mac) {
    let keys = [];

    let search = await Promise.all([
      rclient.keysAsync('lastsumflow:' + mac + ':*'),
      rclient.keysAsync('category:host:' + mac + ':*'),
      rclient.keysAsync('app:host:' + mac + ':*'),
    ])

    keys.push(
      ... _.flatten(search),
      'lastcategory:host:' + mac,
      'lastapp:host:' + mac
    )

    return Promise.all([
      rclient.delAsync(keys),
      this.removeAllFlowKeys(mac),
      this.removeAllSumFlows(mac),
    ])
  }
}


module.exports = FlowAggrTool;
