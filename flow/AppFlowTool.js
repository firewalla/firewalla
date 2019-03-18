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

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird')

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const util = require('util');

let instance = null

class AppFlowTool {
  constructor() {
    if(instance === null) {
      instance = this
      this.appExpireTime = 3600 * 24 // by default 24 hours
    }
    return instance
  }

  getAppFlowKey(mac, app) {
    return `appflow:${mac}:${app}`
  }

  addAppFlowObject(mac, app, object) {
    return this.addAppFlow(mac, app, object.ts, object.duration, object.download, object.upload)
  }

  addAppFlow(mac, app, timestamp, duration, downloadBytes, uploadBytes) {
    let json = {
      ts: timestamp,
      duration: duration,
      download: downloadBytes,
      upload: uploadBytes
    }

    let key = this.getAppFlowKey(mac, app)

    return async(() => {
      await (rclient.zaddAsync(key, timestamp, JSON.stringify(json)))
      await (rclient.expireAsync(key, this.appExpireTime)) // whenever there is a new update, reset the expire time
    })()
  }

  delAllApps(mac) {
    return async(() => {
      let apps = await (this.getApps(mac))
      apps.forEach((app) => {
        await (this.delAppFlow(mac, app))
      })
    })()
  }

  delAppFlow(mac, app) {
    let key = this.getAppFlowKey(mac, app)

    return rclient.delAsync(key)
  }

  getApps(mac) {
    mac = mac || '*' // match all mac addresses if mac is not defined
    let keyPattern = this.getAppFlowKey(mac, '*')
    return async(() => {
      let keys = await (rclient.keysAsync(keyPattern))
      let apps = keys.map((key) => {
        let result = key.match(/[^:]*$/)
        if(result) {
          return result[0]
        } else {
          return null
        }
      }).filter((x) => x != null)
      
      return apps.filter((elem, pos) => {
        return apps.indexOf(elem) == pos;
      })

    })()
  }

  getAppMacAddresses(app) {
    let keyPattern = this.getAppFlowKey('*', app)

    return async(() => {
      let keys = await (rclient.keysAsync(keyPattern))
      return keys.map((key) => {
        let result = key.match(/appflow:(.*):[^:]*/) // locate mac address
        if(result) {
          return result[1]
        } else {
          return null
        }
      }).filter((x) => x != null)
    })()
  }

  getAppFlow(mac, app, options) {
    let key = this.getAppFlowKey(mac, app)

    options = options || {}

    let end = options.end || new Date() / 1000;
    let begin = options.begin || (end - 3600 * 24)

    return async(() => {
      let results = await (rclient.zrevrangebyscoreAsync(key, end, begin))
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

  cleanupAppFlow(mac, app) {
    let key = this.getAppFlowKey(mac, app)

    let now = new Date() / 1000
    let _24hoursAgo = now - 3600 * 24

    return rclient.zremrangebyscoreAsync(key, '-inf', `(${_24hoursAgo}`)
  }
}

module.exports = AppFlowTool
