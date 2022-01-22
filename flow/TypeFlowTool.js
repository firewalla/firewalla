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

const log = require("../net2/logger.js")(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()
const platform = require('../platform/PlatformLoader.js').getPlatform();
const instance = []

class TypeFlowTool {
  // type should be either 'app' or 'category'
  constructor(dimension) {
    if (!['app', 'category'].includes(dimension)) throw new Error(`Dimension not supported, ${dimension}`)

    if(!instance[dimension]) {
      instance[dimension] = this
      this.dimension = dimension
      this.typeExpireTime = platform.getRetentionTimeMultiplier() * 3600 * 24
    }
    return instance[dimension]
  }

  getTypeFlowKey(mac, type) {
    return `${this.dimension}flow:${mac}:${type}`
  }

  addTypeFlowObject(mac, type, object) {
    return this.addTypeFlow(mac, type, object.ts, object.duration, object.download, object.upload)
  }

  async addTypeFlow(mac, type, timestamp, duration, downloadBytes, uploadBytes) {
    const json = {
      duration: duration,
      download: downloadBytes,
      upload: uploadBytes
    }

    const key = this.getTypeFlowKey(mac, type)

    await rclient.zaddAsync(key, timestamp, JSON.stringify(json))
    await rclient.expireAsync(key, this.typeExpireTime) // whenever there is a new update, reset the expire time
  }

  async delAllTypes(mac) {
    const types = await this.getTypes(mac)
    for (const type of types) {
      await this.delTypeFlow(mac, type)
    }
  }

  delTypeFlow(mac, type) {
    const key = this.getTypeFlowKey(mac, type)

    return rclient.delAsync(key)
  }

  async getTypes(mac) {
    mac = mac || '*' // match all mac addresses if mac is not defined
    const keyPattern = this.getTypeFlowKey(mac, '*')
    const keys = await rclient.scanResults(keyPattern, 1000)
    const types = new Set()
    keys && keys.forEach(key => {
      const result = key.split(':').pop();
      if (result && result !== 'intel') {
        types.add(result)
      }
    })

    return [ ... types ]
  }

  async getTypeMacAddresses(type) {
    const keyPattern = this.getTypeFlowKey('*', type)

    const keys = await rclient.scanResults(keyPattern, 1000)
    const results = []
    keys.forEach(key => {
      const regex = new RegExp(`${this.dimension}flow:(.*):[^:]*`)
      const result = key.match(regex) // locate mac address
      if (result) {
        results.push(result)
      }
    })
    return results
  }

  async getTypeFlow(mac, type, options) {
    const key = this.getTypeFlowKey(mac, type)

    options = options || {}

    const end = options.end || new Date() / 1000;
    const begin = options.begin || (end - 3600 * 24)

    const flowWithScore = await rclient.zrevrangebyscoreAsync(key, end, begin, 'withscores')

    const results = []
    let jsonString
    while (jsonString = flowWithScore.shift()) {
      const score = flowWithScore.shift()
      if (!score) continue

      try {
        const obj = JSON.parse(jsonString)
        obj.device = mac
        obj.ts = Math.round(score * 100) / 100
        results.push(obj)
      } catch (err) {
        log.error(`Failed to parse JSON String ${jsonString}, for ${mac}, from ${begin} to ${end}`);
      }
    }
    return results
  }

}

module.exports = TypeFlowTool
