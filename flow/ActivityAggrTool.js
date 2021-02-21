/*    Copyright 2021 Firewalla Inc.
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

const log = require("../net2/logger.js")(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()
const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const instance = []

class ActivityAggrTool {
  // type should be either 'app' or 'category'
  constructor(dimension) {
    if (!['app', 'category'].includes(dimension)) throw new Error(`Dimension not supported, ${dimension}`)

    if(!instance[dimension]) {
      instance[dimension] = this
      this.dimension = dimension
    }
    return instance[dimension]
  }

  async addActivityFlows(mac, interval, ts, traffic, expire) {
    expire = expire || 24 * 3600; // by default keep 24 hours

    let key = flowAggrTool.getFlowKey(mac, this.dimension, interval, ts);
    let args = [key];
    for(let t in traffic) {
      let duration = (traffic[t] && traffic[t]['duration']) || 0;
      args.push(duration)

      let payload = {}
      payload.device = mac
      payload[this.dimension] = t
      args.push(JSON.stringify(payload))
    }

    args.push(0);
    args.push("_"); // placeholder to keep key exists

    await rclient.zaddAsync(args)
    return rclient.expireAsync(key, expire)
  }

  getKey(begin, end, options) {
    if (options.intf) {
      return `${this.dimension}:intf:${options.intf}:${begin}:${end}`;
    } else if (options.tag) {
      return `${this.dimension}:tag:${options.tag}:${begin}:${end}`;
    } else if(options.mac) {
      return `${this.dimension}:host:${options.mac}:${begin}:${end}`
    } else {
      return `${this.dimension}:system:${begin}:${end}`
    }
  }

  async keyExists(begin, end, options) {
    let key = this.getKey(begin, end, options)
    let exists = await rclient.existsAsync(key)
    return exists == 1
  }

  async setActivity(begin, end, data, options) {
    options = options || {}

    let key = this.getKey(begin, end, options)
    let expire = options.expireTime || 24 * 60; // by default expire in 24 minutes
    await rclient.setAsync(key, JSON.stringify(data))
    await rclient.expireAsync(key, expire)
    if(options.mac && options.setLastSumFlow) {
      await this.setLastActivity(options.mac, key)
    }
  }

  async getActivityByKey(key) {
    let dataString = await rclient.getAsync(key)
    if(!dataString) {
      return null
    }

    try {
      return JSON.parse(dataString)
    } catch(err) {
      log.error("Failed to parse json:", dataString, "err:", err);
      return null
    }
  }

  getActivity(begin, end, options) {
    options = options || {}

    const key = this.getKey(begin, end, options)
    return this.getActivityByKey(key, options)
  }

  getLastActivityKey(mac) {
    return `last${this.dimension}:host:${mac}`;
  }

  setLastActivity(mac, keyName) {
    const key = this.getLastActivityKey(mac)
    return rclient.setAsync(key, keyName);
  }

  getLastActivity(mac) {
    const key = this.getLastActivityKey(mac)
    return rclient.getAsync(key);
  }
}

module.exports = ActivityAggrTool
