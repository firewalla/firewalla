/*    Copyright 2016-2024 Firewalla Inc.
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

const MAX_FLOW_PER_SUM = 400

const COMMON_SUMFLOW_KEYS = [ 'domain', 'port', 'devicePort', 'fd', 'dstMac', 'reason', 'intra' ]
const FLOW_STR_KEYS = COMMON_SUMFLOW_KEYS.concat('destIP')
const TOPFLOW_KEYS = COMMON_SUMFLOW_KEYS.concat('device')

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

  getFlowKey(mac, dimension, interval, ts, fd) {
    const tick = Math.ceil(ts / interval) * interval
    return `aggrflow:${mac}:${dimension}:${fd ? `${fd}:` : ""}${interval}:${tick}`;
  }

  getSumFlowKey(target, dimension, begin, end, fd) {
    return ( !target ? 'syssumflow' :
      target.startsWith('global') ? 'syssumflow'+target.substring(6) : 'sumflow:'+target )
      + (dimension ? ':'+dimension : '')
      + (fd ? ':'+fd : '')
      + ((begin && end) ? `:${begin}:${end}` : '');
  }

  // aggrflow:<device_mac>:download:10m:<ts>
  async flowExists(mac, dimension, interval, ts) {
    let key = this.getFlowKey(mac, dimension, interval, ts);
    const results = await rclient.existsAsync(key)
    return results == 1
  }

  // key: aggrflow:<device_mac>:<direction>:<interval>:<ts>
  // content: destination ip address
  // score: traffic size
  addFlow(mac, dimension, interval, ts, destIP, traffic) {
    let key = this.getFlowKey(mac, dimension, interval, ts);
    return rclient.zaddAsync(key, traffic, destIP);
  }

  getFlowStr(mac, entry) {
    const flow = {device: mac};
    FLOW_STR_KEYS.forEach(f => {
      if (entry[f]) flow[f] = entry[f]
    })
    return JSON.stringify(flow);
  }

  removeFlow(mac, dimension, interval, ts, destIP) {
    let key = this.getFlowKey(mac, dimension, interval, ts);
    return rclient.zremAsync(key, destIP);
  }

  removeFlowKey(mac, dimension, interval, ts) {
    let key = this.getFlowKey(mac, dimension, interval, ts);
    return rclient.unlinkAsync(key);
  }

  async removeAllFlowKeys(mac, dimension, interval) {
    let keyPattern =
      !dimension ? util.format("aggrflow:%s:*", mac) :
      !interval         ? util.format("aggrflow:%s:%s:*", mac, dimension) :
                          util.format("aggrflow:%s:%s:%s:*", mac, dimension, interval);

    let keys = await rclient.scanResults(keyPattern);

    if (keys.length)
      return rclient.unlinkAsync(keys);
    else
      return 0
  }

  // this is to make sure flow data is not flooded enough to consume all memory
  async trimSumFlow(sumFlowKey, options) {
    let max_flow = MAX_FLOW_PER_SUM

    if(options.max_flow) {
      max_flow = options.max_flow
    }

    // only keep the MAX_FLOW_PER_SUM highest flows
    let count = await rclient.zremrangebyrankAsync(sumFlowKey, 0, -1 * max_flow)
    if (count) log.debug(`${count} flows are trimmed from ${sumFlowKey}`)
  }

  async incrSumFlow(uid, traffic, measurement, options, fd) {
    const {begin, end} = options;
    const expire = options.expireTime || 24 * 60;
    const sumFlowKey = this.getSumFlowKey(uid, measurement, begin, end, fd);
    const transactions = [];
    for (const key in traffic) {
      const entry = traffic[key];
      if (!entry)
        continue;
      if (fd && entry.fd != fd)
        continue;

      const incr = entry && (entry[measurement] || entry.count) || 0;
      const mac = entry.device || uid;
      if (incr) {
        const flowStr = this.getFlowStr(mac, entry);
        transactions.push(['zincrby', sumFlowKey, incr, flowStr]);
      }
    }
    if (!_.isEmpty(transactions)) {
      transactions.push(['expire', sumFlowKey, expire]);
      transactions.push(['zremrangebyrank', sumFlowKey, 0, - (options.max_flow || MAX_FLOW_PER_SUM)])
      await rclient.multi(transactions).execAsync();
    }
  }

  // sumflow:<device_mac>:download:<begin_ts>:<end_ts>
  // content: destination ip address
  // score: traffic size

  // interval is the interval of each aggr flow (aggrflow:...)
  async addSumFlow(dimension, options, fd) {

    if(!options.begin || !options.end) {
      throw new Error("Require begin and end");
    }

    let begin = options.begin;
    let end = options.end;

    // if working properly, sumflow should be refreshed in every 10 minutes
    let expire = options.expireTime || 24 * 60; // by default expire in 24 minutes
    let interval = options.interval || 600; // by default 10 mins
    const summedInterval = options.summedInterval || 0; // sumflow interval data that are already calculated

    // if below are all undefined, by default it will scan over all machines
    let intf = options.intf;
    let tag = options.tag;
    let mac = options.mac;
    let target = intf && ('intf:' + intf) || tag && ('tag:' + tag) || mac;

    let sumFlowKey = this.getSumFlowKey(target, dimension, begin, end, fd);

    try {
      if(options.skipIfExists) {
        let exists = await rclient.existsAsync(sumFlowKey);
        if(exists) {
          return;
        }
      }

      // let endString = compactTime(end)
      // let beginString = compactTime(begin)
      // log.verbose(`Summing ${target||'all'} ${dimension} between ${beginString} and ${endString}`)

      let ticks = this.getTicks(begin, end, interval);
      let summedTicks = summedInterval ? this.getTicks(begin, end, summedInterval) : [];
      let tickKeys = null

      if (!_.isEmpty(summedTicks)) { // directly calculate sumflow from sub-intervals' (usually hourly) sumflow buckets
        tickKeys = summedTicks.map(tick => this.getSumFlowKey(target, dimension, tick, tick + summedInterval, fd));
      } else {
        if (!_.isEmpty(options.macs)) { // calculate collection's sumflow from member's sumflow
          tickKeys = options.macs.map(mac => this.getSumFlowKey(mac, dimension, begin, end, fd));
        } else { // calculate single device sumflow from aggrflow
          tickKeys = ticks.map(tick => this.getFlowKey(mac, dimension, interval, tick, fd));
        }
      }

      let num = tickKeys.length;

      if(num <= 0) {
        // log.debug("Nothing to sum for key", sumFlowKey);

        // add a placeholder in redis to avoid duplicated queries
        // await rclient.zaddAsync(sumFlowKey, 0, '_');
        // await rclient.expireAsync(sumFlowKey, expire)
        return;
      }

      // ZUNIONSTORE destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM|MIN|MAX]
      let args = [sumFlowKey, num];
      args = args.concat(tickKeys);

      const multi = rclient.multi()
      multi.zunionstore(args);

      if (options.setLastSumFlow) {
        const lastKey = 'last' + this.getSumFlowKey(target, dimension, null, null, fd)
        multi.set(lastKey, sumFlowKey);
        multi.expire(lastKey, 24 * 60 * 60);
      }
      multi.zadd(sumFlowKey, 0, '_')
      multi.zremrangebyrank(sumFlowKey, 0, -(options.max_flow || MAX_FLOW_PER_SUM))
      multi.expire(sumFlowKey, expire)

      const results = await multi.execAsync()

      return results[0];
    } catch(err) {
      log.error('Error adding sumflow', sumFlowKey, err)
    }
  }

  async setLastSumFlow(target, dimension, fd, keyName) {
    const key = 'last' + this.getSumFlowKey(target, dimension, null, null, fd)
    await rclient.setAsync(key, keyName);
    await rclient.expireAsync(key, 24 * 60 * 60);
  }

  getLastSumFlow(target, dimension, fd) {
    const key = 'last' + this.getSumFlowKey(target, dimension, null, null, fd)
    return rclient.getAsync(key);
  }

  getSumFlow(mac, dimension, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, dimension, begin, end);

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
            const flow = _.pick(json, TOPFLOW_KEYS);
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

  getTopSumFlow(mac, dimension, begin, end, count) {
    let sumFlowKey = this.getSumFlowKey(mac, dimension, begin, end);

    return this.getTopSumFlowByKey(sumFlowKey, count);
  }

  async removeAllSumFlows(mac, dimension) {
    let keyPattern = dimension
      ? util.format("sumflow:%s:%s:*", mac, dimension)
      : util.format("sumflow:%s:*", mac);

    let keys = await rclient.scanResults(keyPattern);

    if (keys.length)
      return rclient.unlinkAsync(keys);
    else
      return 0
  }

  getFlowTrafficByDestIP(mac, dimension, interval, ts, destIP) {
    let key = this.getFlowKey(mac, dimension, interval, ts);

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

  async recordDeviceLastFlowTs(uid, ts) {
    await rclient.zaddAsync("deviceLastFlowTs", ts, uid);
  }

  async getDevicesWithFlowTs(begin, end) {
    return rclient.zrangebyscoreAsync("deviceLastFlowTs", begin, end || "+inf");
  }
}


module.exports = FlowAggrTool;
