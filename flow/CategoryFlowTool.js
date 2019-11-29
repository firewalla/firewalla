/*    Copyright 2016 Firewalla INC
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

  async addCategoryFlow(mac, category, timestamp, duration, downloadBytes, uploadBytes) {
    let json = {
      ts: timestamp,
      duration: duration,
      download: downloadBytes,
      upload: uploadBytes
    }

    let key = this.getCategoryFlowKey(mac, category)

    await rclient.zaddAsync(key, timestamp, JSON.stringify(json))
    await rclient.expireAsync(key, this.categoryExpireTime) // whenever there is a new update, reset the expire time
  }

  delCategoryFlow(mac, category) {
    let key = this.getCategoryFlowKey(mac, category)

    return rclient.delAsync(key)
  }

  async getCategoryFlow(mac, category, options) {
    let key = this.getCategoryFlowKey(mac, category)

    options = options || {}

    let end = options.end || new Date() / 1000;
    let begin = options.begin || (end - 3600 * 24)

    let results = await rclient.zrevrangebyscoreAsync(key, end, begin)
    return results.map((jsonString) => {
      try {
        return JSON.parse(jsonString)
      } catch (err) {
        log.error("Failed to parse JSON String:", jsonString);
        return null;
      }
    }).filter(x => x != null)
  }

  async delAllCategories(mac) {
    let categories = await this.getCategories(mac)
    for (const category of categories) {
      await this.delCategoryFlow(mac, category)
    }
  }

  async getCategories(mac) {
    mac = mac || '*' // match all mac addresses if mac is not defined
    const keyPattern = this.getCategoryFlowKey(mac, '*')
    const keys = await rclient.keysAsync(keyPattern)
    const categories = new Set();
    keys && keys.forEach((key) => {
      const result = key.split(':').pop();
      if (result && result !== 'intel') {
        categories.add(result)
      }
    })

    return [ ... categories ];
  }

  async getCategoryMacAddresses(category) {
    let keyPattern = this.getCategoryFlowKey('*', category)

    let keys = await rclient.keysAsync(keyPattern)
    return keys.map((key) => {
      let result = key.match(/categoryflow:(.*):[^:]*/) // locate mac address
      if (result) {
        return result[1]
      } else {
        return null
      }
    }).filter((x) => x != null)
  }

  cleanupCategoryFlow(mac, category) {
    let key = this.getCategoryFlowKey(mac, category)

    let now = new Date() / 1000
    let _24hoursAgo = now - 3600 * 24

    return rclient.zremrangebyscoreAsync(key, '-inf', `(${_24hoursAgo}`)
  }
}

module.exports = CategoryFlowTool
