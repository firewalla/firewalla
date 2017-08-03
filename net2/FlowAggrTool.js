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

  addActivityFlows(mac, interval, ts, traffics, expire) {
    expire = expire || 48 * 3600; // by default keep 48 hours

    let key = this.getFlowKey(mac, "app", interval, ts);
    let args = [key];
    for(let app in traffics) {
      let duration = (traffics[app] && traffics[app]['duration']) || 0;
      args.push(duration)
      args.push(JSON.stringify({
        device: mac,
        app: app
      }))
    }

    args.push(0);
    args.push("_"); // placeholder to keep key exists

    return rclient.zaddAsync(args)
      .then(() => {
      return rclient.expireAsync(key, expire)
      });
  }

  addFlows(mac, trafficDirection, interval, ts, traffics, expire) {
    expire = expire || 48 * 3600; // by default keep 48 hours

    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    let args = [key];

    for(let destIP in traffics) {
      let traffic = (traffics[destIP] && traffics[destIP][trafficDirection]) || 0;
      args.push(traffic)
      args.push(JSON.stringify({
        device: mac,
        destIP: destIP
      }))
    }

    args.push(0);
    args.push("_"); // placeholder to keep key exists

    return rclient.zaddAsync(args)
      .then(() => {
      return rclient.expireAsync(key, expire)
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

  removeAllFlowKeys(mac, trafficDirection, interval) {
    let keyPattern = util.format("aggrflow:%s:%s:%s:*", mac, trafficDirection, interval);

    return async(() => {
      let keys = await (rclient.keysAsync(keyPattern));
      keys.forEach((key) => {
        await (rclient.delAsync(key))
      })
    })();
  }

  // sumflow:<device_mac>:download:<begin_ts>:<end_ts>
  // content: destination ip address
  // score: traffic size

  // interval is the interval of each aggr flow (aggrflow:...)
  addSumFlow(trafficDirection, options) {

    if(!options.begin || !options.end) {
      return Promise.reject(new Error("Require begin and end"));
    }

    let begin = options.begin;
    let end = options.end;
    let expire = options.expireTime || 2 * 3600; // by default expire in two hours
    let interval = options.interval || 600; // by default 10 mins

    let mac = options.mac; // if mac is undefined, by default it will scan over all machines

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    if(mac) {
      log.info(util.format("Summing %s %s flows between %s and %s", mac, trafficDirection, beginString, endString));
    } else {
      log.info(util.format("Summing all %s flows in the network between %s and %s", trafficDirection, beginString, endString));
    }

    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);
    let ticks = this.getTicks(begin, end, interval);
    let tickKeys = null

    return async(() => {

      if(mac) {
        tickKeys = ticks.map((tick) => this.getFlowKey(mac, trafficDirection, interval, tick));
      } else {
        // * is a hack code here, in redis, it means matching everything during keys command
        tickKeys = ticks.map((tick) => {
          let keyPattern = this.getFlowKey('*', trafficDirection, interval, tick);
          let keys = await (rclient.keysAsync(keyPattern));
          return keys;
        }).reduce((a,b) => a.concat(b), []); // reduce version of flatMap
      }

      let num = tickKeys.length;

      if(num <= 0) {
        log.warn("Nothing to sum for key", sumFlowKey, {});
        return Promise.resolve();
      }

      // ZUNIONSTORE destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM|MIN|MAX]
      let args = [sumFlowKey, num];
      args.push.apply(args, tickKeys);

      log.debug("zunionstore args: ", args, {});

      if(options.skipIfExists) {
        let exists = await(rclient.keysAsync(sumFlowKey));
        if(exists.length > 0) {
          return;
        }
      }

      let result = await (rclient.zunionstoreAsync(args));
      if(result > 0) {
        await(this.setLastSumFlow(mac, trafficDirection, sumFlowKey));
        await(rclient.expireAsync(sumFlowKey, expire));
      }

      return Promise.resolve(result);
    })();
  }

  setLastSumFlow(mac, trafficDirection, keyName) {
    let key = util.format("lastsumflow:%s:%s", mac, trafficDirection);
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

  getTopSumFlowByKey(key, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    return async(() => {
      let destAndScores = await (rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count));
      let results = [];
      for(let i = 0; i < destAndScores.length; i++) {
        if(i % 2 === 1) {
          let payload = destAndScores[i-1];
          let count = destAndScores[i];
          if(payload !== '_' && count !== 0) {
            try {
              let json = JSON.parse(payload);
              results.push({ip: json.destIP, device: json.device, count: count});
            } catch(err) {
              log.error("Failed to parse payload: ", payload, {});
            }
          }
        }
      }
      return results;
    })();
  }

  getActivitySumFlowByKey(key, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    return async(() => {
      let appAndScores = await (rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count));
      let results = [];
      for(let i = 0; i < appAndScores.length; i++) {
        if(i % 2 === 1) {
          let payload = appAndScores[i-1];
          let count = appAndScores[i];
          if(payload !== '_' && count !== 0) {
            try {
              let json = JSON.parse(payload);
              results.push({app: json.app, device: json.device, count: count});
            } catch(err) {
              log.error("Failed to parse payload: ", payload, {});
            }
          }
        }
      }
      return results;
    })();
  }

  getTopSumFlow(mac, trafficDirection, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    return this.getTopSumFlowByKey(sumFlowKey, count);
  }

  removeAllSumFlows(mac, trafficDirection) {
    let keyPattern = util.format("sumflow:%s:%s:*", mac, trafficDirection);

    return async(() => {
      let keys = await (rclient.keysAsync(keyPattern));
      keys.forEach((key) => {
        await (rclient.delAsync(key))
      })
    })();
  }

  getFlowTrafficByDestIP(mac, trafficDirection, interval, ts, destIP) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);

    // MUST device first, destIP second!!
    return rclient.zscoreAsync(key, JSON.stringify({device:mac, destIP: destIP}));
  }

  getActivityFlowTrafficByActivity(mac, interval, ts, app) {
    let key = this.getFlowKey(mac, "app", interval, ts);

    return async(() => {
      let xx = await (rclient.zrangeAsync(key, 0, -1, 'withscores'));
      let score = await (rclient.zscoreAsync(key, JSON.stringify({device:mac, app: app})));
      return score;
    })();
    // MUST device first, destIP second!!
    return
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
}


module.exports = FlowAggrTool;
