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

const log = require("../net2/logger.js")(__filename);

const redis = require('redis')
const rclient = redis.createClient()

const Promise = require('bluebird')
Promise.promisifyAll(redis.RedisClient.prototype)
Promise.promisifyAll(redis.Multi.prototype)

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const util = require('util');

let instance = null

class CategoryFlowTool {
  constructor() {
    if(instance === null) {
      instance = this
      this.categoryExpireTime = 3600 * 24 // by default 24 hours
    }
    return instance
  }

  getCategoryFlowKey(mac, category) {
    return `categoryflow:${mac}:${category}`
  }

  addCategoryFlowObject(mac, category, object) {
    return this.addCategoryFlow(mac, category, object.ts, object.duration, object.download, object.upload)
  }

  addCategoryFlow(mac, category, timestamp, duration, downloadBytes, uploadBytes) {
    let json = {
      ts: timestamp,
      duration: duration,
      download: downloadBytes,
      upload: uploadBytes
    }

    let key = this.getCategoryFlowKey(mac, category)

    return async(() => {
      await (rclient.zaddAsync(key, timestamp, JSON.stringify(json)))
      await (rclient.expireAsync(key, this.categoryExpireTime)) // whenever there is a new update, reset the expire time
    })()
  }

  delCategoryFlow(mac, category) {
    let key = this.getCategoryFlowKey(mac, category)

    return rclient.delAsync(key)
  }

  getCategoryFlow(mac, category) {
    let key = this.getCategoryFlowKey(mac, category)

    let now = new Date() / 1000
    let _24hoursAgo = now - 3600 * 24

    return async(() => {
      let results = await (rclient.zrevrangebyscoreAsync(key, now, _24hoursAgo))
      return results.map((jsonString) => {
        try {
          return JSON.parse(jsonString)
        } catch(err) {
          log.error("Failed to parse JSON String:", jsonString, {})
          return null;
        }
      }).filter(x => x != null)
    })()
  }

  cleanupCategoryFlow(mac, category) {
    let key = this.getCategoryFlowKey(mac, category)

    let now = new Date() / 1000
    let _24hoursAgo = now - 3600 * 24

    return rclient.zremrangebyscoreAsync(key, '-inf', `(${_24hoursAgo}`)
  }
}

module.exports = CategoryFlowTool
