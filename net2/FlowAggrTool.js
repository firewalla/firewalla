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
const { compactTime } = require('../util/util')

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

  getFlowKey(mac, trafficDirection, interval, ts, fd) {
    const tick = Math.ceil(ts / interval) * interval
    return `aggrflow:${mac}:${trafficDirection}:${fd ? `${fd}:` : ""}${interval}:${tick}`;
  }

  getSumFlowKey(target, trafficDirection, begin, end, fd) {
    return `${target ? `sumflow:${target}` : "syssumflow"}:${trafficDirection}:${fd ? `${fd}:` : ""}${begin}:${end}`;
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

  async addFlows(mac, trafficDirection, interval, ts, traffic, expire, fd) {
    expire = expire || 24 * 3600; // by default keep 24 hours

    const key = this.getFlowKey(mac, trafficDirection, interval, ts, fd);
    log.debug(`Aggregating ${key}`)

    // this key is capped at MAX_FLOW_PER_AGGR, no big deal here
    const prevAggrFlows = await rclient.zrangeAsync(key, 0, -1, 'withscores')

    const result = {}

    let flowStr
    while (flowStr = prevAggrFlows.shift()) {
      const score = prevAggrFlows.shift()
      if (score) result[flowStr] = Number(score)
    }

    log.debug(result)
    for (const target in traffic) {
      const entry = traffic[target]
      if (!entry) continue
      if (fd && entry.fd != fd)
        continue;

      let t = entry && (entry[trafficDirection] || entry.count) || 0;

      if (['upload', 'download'].includes(trafficDirection) && t < MIN_AGGR_TRAFFIC) {
        continue                // skip very small traffic
      }

      // mac in json is used as differentiator on aggreation (zunionstore), don't remove it here
      const flow = { device: mac };

      [ 'destIP', 'domain', 'port', 'devicePort', 'fd', 'dstMac' ].forEach(f => {
        if (entry[f]) flow[f] = entry[f]
      })

      flowStr = JSON.stringify(flow)
      if (!(flowStr in result))
        result[flowStr] = t
      else
        result[flowStr] += t
    }

    // sort&trim within node is probably better than doing it in redis
    const sortedResult = Object.entries(result).sort((a,b) => b[1] - a[1])
    log.debug(sortedResult)
    if (!sortedResult.length) return

    const trimmed = sortedResult.length - MAX_FLOW_PER_AGGR
    if (trimmed > 0) {
      log.verbose(`${trimmed} flows are trimmed from ${key}`)

      await rclient.zincrbyAsync(key, trimmed, JSON.stringify({
        device: mac,
        destIP: "0.0.0.0"       // special ip address to indicate some flows were skipped due to overflow protection
      }))
    }

    const args = [key]
    // only keep the MAX_FLOW_PER_AGGR highest flows
    for (const ss of sortedResult.slice(0, MAX_FLOW_PER_AGGR)) {
      args.push(ss[1], ss[0])
    }

    await rclient.zaddAsync(args)
    await rclient.expireAsync(key, expire)
  }

  removeFlow(mac, trafficDirection, interval, ts, destIP) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.zremAsync(key, destIP);
  }

  removeFlowKey(mac, trafficDirection, interval, ts) {
    let key = this.getFlowKey(mac, trafficDirection, interval, ts);
    return rclient.unlinkAsync(key);
  }

  async removeAllFlowKeys(mac, trafficDirection, interval) {
    let keyPattern =
      !trafficDirection ? util.format("aggrflow:%s:*", mac) :
      !interval         ? util.format("aggrflow:%s:%s:*", mac, trafficDirection) :
                          util.format("aggrflow:%s:%s:%s:*", mac, trafficDirection, interval);

    let keys = await rclient.scanResults(keyPattern);

    if (keys.length)
      return rclient.unlinkAsync(keys);
    else
      return 0
  }

  // this is to make sure flow data is not flooded enough to consume all memory
  async trimSumFlow(sumFlowKey, options) {
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

    let count = await rclient.zremrangebyrankAsync(sumFlowKey, 0, -1 * max_flow) // only keep the MAX_FLOW_PER_SUM highest flows

    if (count) log.verbose(`${count} flows are trimmed from ${sumFlowKey}`)
  }

  // sumflow:<device_mac>:download:<begin_ts>:<end_ts>
  // content: destination ip address
  // score: traffic size

  // interval is the interval of each aggr flow (aggrflow:...)
  async addSumFlow(trafficDirection, options, fd) {

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

    let sumFlowKey = this.getSumFlowKey(target, trafficDirection, begin, end, fd);

    try {
      if(options.skipIfExists) {
        let exists = await rclient.existsAsync(sumFlowKey);
        if(exists) {
          return;
        }
      }

      let endString = compactTime(end)
      let beginString = compactTime(begin)

      log.verbose(`Summing ${target||'all'} ${trafficDirection} between ${beginString} and ${endString}`)

      let ticks = this.getTicks(begin, end, interval);
      let tickKeys = null

      if (intf || tag) {
        tickKeys = _.flatten(options.macs.map(mac => ticks.map(tick => this.getFlowKey(mac, trafficDirection, interval, tick))));
      } else if (mac) {
        tickKeys = ticks.map(tick => this.getFlowKey(mac, trafficDirection, interval, tick));
      } else {
        // only call keys once to improve performance
        const keyPattern = `aggrflow:*:${trafficDirection}:${fd ? `${fd}:` : ""}${interval}:*`
        const matchedKeys = await rclient.scanResults(keyPattern);

        tickKeys = matchedKeys.filter((key) => {
          return ticks.some((tick) => key.endsWith(`:${tick}`))
        });
      }

      let num = tickKeys.length;

      if(num <= 0) {
        log.debug("Nothing to sum for key", sumFlowKey);

        // add a placeholder in redis to avoid duplicated queries
        // await rclient.zaddAsync(sumFlowKey, 0, '_');
        // await rclient.expireAsync(sumFlowKey, expire)
        return;
      }

      // ZUNIONSTORE destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM|MIN|MAX]
      let args = [sumFlowKey, num];
      args = args.concat(tickKeys);

      log.debug("zunionstore args: ", args);

      let result = await rclient.zunionstoreAsync(args);
      if(options.setLastSumFlow) {
        await this.setLastSumFlow(target, trafficDirection, sumFlowKey)
      }
      if (result > 0) {
        await this.trimSumFlow(sumFlowKey, options)
      } else {
        await rclient.zaddAsync(sumFlowKey, 0, '_')
      }
      await rclient.expireAsync(sumFlowKey, expire)

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
            if (json.destIP) {
              // this is added as a counter for trimmed flows, check FlowAggrTool.addFlow()
              if (json.destIP == '0.0.0.0') continue
              flow.ip = json.destIP
            }
            results.push(flow);
          } catch(err) {
            log.error("Failed to parse payload: ", payload);
          }
        }
      }
    }
    return results;
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

  getTopSumFlow(mac, trafficDirection, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, trafficDirection, begin, end);

    return this.getTopSumFlowByKey(sumFlowKey, count);
  }

  async removeAllSumFlows(mac, trafficDirection) {
    let keyPattern = trafficDirection
      ? util.format("sumflow:%s:%s:*", mac, trafficDirection)
      : util.format("sumflow:%s:*", mac);

    let keys = await rclient.scanResults(keyPattern);

    if (keys.length)
      return rclient.unlinkAsync(keys);
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
      rclient.scanResults('lastsumflow:tag:' + tag + ':*'),
      rclient.scanResults('category:tag:' + tag + ':*'),
      rclient.scanResults('app:tag:' + tag + ':*'),
    ]);

    keys.push(
      ... _.flatten(search),
      // 'lastcategory:tag:' + tag,
      // 'lastapp:tag:' + tag
    );

    return Promise.all([
      rclient.unlinkAsync(keys).catch((err) => {}),
      // this.removeAllFlowKeys(tag),
      this.removeAllSumFlows('tag:' + tag),
    ]);
  }

  async removeAggrFlowsAll(mac) {
    let keys = [];

    let search = await Promise.all([
      rclient.scanResults('lastsumflow:' + mac + ':*'),
      rclient.scanResults('category:host:' + mac + ':*'),
      rclient.scanResults('app:host:' + mac + ':*'),
    ])

    keys.push(
      ... _.flatten(search),
      'lastcategory:host:' + mac,
      'lastapp:host:' + mac
    )

    return Promise.all([
      rclient.unlinkAsync(keys),
      this.removeAllFlowKeys(mac),
      this.removeAllSumFlows(mac),
    ])
  }
}


module.exports = FlowAggrTool;
