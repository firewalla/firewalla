/*    Copyright 2016-2022 Firewalla Inc.
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

const MAX_FLOW_PER_AGGR = 200
const MAX_FLOW_PER_SUM = 30000
const MAX_FLOW_PER_HOUR = 7000

const MIN_AGGR_TRAFFIC = 256

function toInt(n){ return Math.floor(Number(n)) }

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

  getSumFlowKey(target, trafficDirection, begin, end) {
    if(target) {
      return util.format("sumflow:%s:%s:%s:%s", target, trafficDirection, begin, end);
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

  // this is to make sure flow data is not flooded enough to consume all memory
  async trimFlow(mac, trafficDirection, interval, ts) {
    const key = this.getFlowKey(mac, trafficDirection, interval, ts);

    let count = await rclient.zremrangebyrankAsync(key, 0, -1 * MAX_FLOW_PER_AGGR) // only keep the MAX_FLOW_PER_AGGR highest flows

    if (!count) return
    const logWithLevel = count > max_flow ? log.info : log.verbose
    logWithLevel(`${count} flows are trimmed from ${key}`)
  }

  async addFlows(mac, trafficDirection, interval, ts, traffic, expire) {
    expire = expire || 24 * 3600; // by default keep 24 hours

    const length = Object.keys(traffic).length // number of dest ips in this aggr flow
    const key = this.getFlowKey(mac, trafficDirection, interval, ts);

    let args = [key];

    if(length > MAX_FLOW_PER_AGGR) { // self protection
      args.push(length)
      args.push(JSON.stringify({
        device: mac,
        destIP: "0.0.0.0"       // special ip address to indicate some flows were skipped due to overflow protection
      }))
    }

    for (const target in traffic) {
      const entry = traffic[target]
      if (!entry) continue

      let t = entry && (entry[trafficDirection] || entry.count) || 0;

      if (['upload', 'download'].includes(trafficDirection) && t < MIN_AGGR_TRAFFIC) {
        continue                // skip very small traffic
      }

      args.push(t)  // score

      // mac in json is used as differentiator on aggreation (zunionstore), don't remove it here
      const result = { device: mac };

      [ 'destIP', 'domain', 'port', 'devicePort', 'fd', 'dstMac' ].forEach(f => {
        if (entry[f]) result[f] = entry[f]
      })

      args.push(JSON.stringify(result))
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

    // if below are all undefined, by default it will scan over all machines
    let intf = options.intf;
    let tag = options.tag;
    let mac = options.mac;
    let target = intf && ('intf:' + intf) || tag && ('tag:' + tag) || mac;

    let sumFlowKey = this.getSumFlowKey(target, trafficDirection, begin, end);

    let count = await rclient.zremrangebyrankAsync(sumFlowKey, 0, -1 * max_flow) // only keep the MAX_FLOW_PER_SUM highest flows

    if (!count) return
    const logWithLevel = count > max_flow ? log.info : log.verbose
    logWithLevel(`${count} flows are trimmed from ${sumFlowKey}`)
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

    // if below are all undefined, by default it will scan over all machines
    let intf = options.intf;
    let tag = options.tag;
    let mac = options.mac;
    let target = intf && ('intf:' + intf) || tag && ('tag:' + tag) || mac;

    let sumFlowKey = this.getSumFlowKey(target, trafficDirection, begin, end);

    try {
      if(options.skipIfExists) {
        let exists = await rclient.existsAsync(sumFlowKey);
        if(exists) {
          return;
        }
      }

      let endString = new Date(end * 1000).toLocaleTimeString();
      let beginString = new Date(begin * 1000).toLocaleTimeString();

      if(target) {
        log.debug(util.format("Summing %s %s flows between %s and %s", target, trafficDirection, beginString, endString));
      } else {
        log.debug(util.format("Summing all %s flows in the network between %s and %s", trafficDirection, beginString, endString));
      }

      let ticks = this.getTicks(begin, end, interval);
      let tickKeys = null

      if (intf || tag) {
        tickKeys = _.flatten(options.macs.map(mac => ticks.map(tick => this.getFlowKey(mac, trafficDirection, interval, tick))));
      } else if (mac) {
        tickKeys = ticks.map(tick => this.getFlowKey(mac, trafficDirection, interval, tick));
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
        await rclient.expireAsync(sumFlowKey, expire)
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
          await this.setLastSumFlow(target, trafficDirection, sumFlowKey)
        }
        await rclient.expireAsync(sumFlowKey, expire)
        await this.trimSumFlow(trafficDirection, options)
      }

      return result;
    } catch(err) {
      log.error('Error adding sumflow', sumFlowKey, err)
    }
  }

  async setLastSumFlow(target, trafficDirection, keyName) {
    const key = `lastsumflow:${target ? target + ':' : ''}${trafficDirection}`
    await rclient.setAsync(key, keyName);
    await rclient.expireAsync(key, 24 * 60 * 60);
  }

  getLastSumFlow(target, trafficDirection) {
    const key = `lastsumflow:${target ? target + ':' : ''}${trafficDirection}`
    return rclient.getAsync(key);
  }

  getSumFlow(mac, trafficDirection, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    return rclient.zrangeAsync(sumFlowKey, 0, count, 'withscores');
  }

  // return a list of destinations sorted by transfer size desc
  async getTopSumFlowByKeyAndDestination(key, type, count) {
    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    const destAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count);
    const results = {};

    for(let i = 0; i < destAndScores.length; i++) {
      if(i % 2 === 1) {
        let payload = destAndScores[i-1];
        let count = Number(destAndScores[i]);
        if(payload !== '_' && count !== 0) {
          try {
            const json = JSON.parse(payload);
            const dest = json.destIP || json.domain;
            const ports = json.port;
            if(!dest) {
              continue;
            }
            if(results[dest]) {
              results[dest].count += count
            } else {
              results[dest] = { count }
            }

            if(ports) {
              if(results[dest].ports) {
                Array.prototype.push.apply(results[dest].ports, ports)
              } else {
                results[dest].ports = ports
              }
            }
          } catch(err) {
            log.error("Failed to parse payload: ", err, payload);
          }
        }
      }
    }

    const array = [];
    for(const dest in results) {
      const result = results[dest]
      if (result.ports) result.ports = _.uniq(result.ports)
      if (type == 'dnsB') {
        result.domain = dest
      } else {
        result.ip = dest
      }
      array.push(result);
    }

    array.sort(function(a, b) {
      return a.count - b.count
    });

    return array;
  }

  async getTopSumFlowByKey(key, count) {
    log.debug('getting top sumflow from key', key, ', count:', count)

    // ZREVRANGEBYSCORE sumflow:B4:0B:44:9F:C1:1A:download:1501075800:1501162200 +inf 0  withscores limit 0 20
    let destAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores', 'limit', 0, count);
    let results = [];
    for(let i = 0; i < destAndScores.length; i++) {
      if(i % 2 === 1) {
        let payload = destAndScores[i-1];
        // TODO: change this to number after most clints are adapted
        let count = destAndScores[i];
        if(payload !== '_' && count !== 0) {
          try {
            const json = JSON.parse(payload);
            const flow = _.pick(json, 'domain', 'type', 'device', 'port', 'devicePort', 'fd', 'dstMac');
            flow.count = count
            if (json.destIP) flow.ip = json.destIP
            results.push(flow);
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

  async removeAggrFlowsAllTag(tag) {
    let keys = [];

    let search = await Promise.all([
      rclient.keysAsync('lastsumflow:tag:' + tag + ':*'),
      rclient.keysAsync('category:tag:' + tag + ':*'),
      rclient.keysAsync('app:tag:' + tag + ':*'),
    ]);

    keys.push(
      ... _.flatten(search),
      // 'lastcategory:tag:' + tag,
      // 'lastapp:tag:' + tag
    );

    return Promise.all([
      rclient.delAsync(keys).catch((err) => {}),
      // this.removeAllFlowKeys(tag),
      this.removeAllSumFlows('tag:' + tag),
    ]);
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
