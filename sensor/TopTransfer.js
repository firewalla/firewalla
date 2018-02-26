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
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const redis = require('redis');
const rclient = redis.createClient();

const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const flowTool = require('../net2/FlowTool.js')()

class TopTransfer extends Sensor {
  constructor() {
    super()
  }

  getTimeSlot() {
    const now = Math.floor(new Date() / 1000)
    return {
      end: Math.floor(now / 60) * 60,
      begin: Math.floor(now / 60) * 60 - 60,
    }
  }

  getKey() {
    return "last60stats"
  }
  
  job() {
    return async(() => {
      const timeSlot = this.getTimeSlot()
      const results = await (flowTool.getAllRecentOutgoingConnectionsMixed(timeSlot))
      results.sort((x, y) => {
        return y.upload + y.download - x.download - x.upload // sort by traffic
      })      
      const timeKey = timeSlot % 60
      return rclient.hsetAsync(this.getKey(), timeKey, JSON.stringify(results.slice(0,3))) // top 3
    })()
  }

  run() {
    setInterval(() => {
      this.job();
    }, this.config.interval || 1000 * 50); // every 50 seconds
  }
}

module.exports = TopTransfer
