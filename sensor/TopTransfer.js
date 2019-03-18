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

const rclient = require('../util/redis_manager.js').getRedisClient()
const Promise = require('bluebird');

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
      results.forEach((x) => {
        delete x.device
        delete x.fd
        delete x.duration
        delete x.country
      })
      
      const topDownloads = JSON.parse(JSON.stringify(results))
      topDownloads.sort((x, y) => {
        return y.download - x.download
      })
      topDownloads.forEach((x) => {
        delete x.upload
      })

      const topUploads = JSON.parse(JSON.stringify(results))
      topUploads.sort((x, y) => {
        return y.upload - x.upload
      })
      topUploads.forEach((x) => {
        delete x.download
      })

      const timeKey = (timeSlot.begin / 60) % 60
      const value = {
        download: topDownloads[0],
        upload: topUploads[0],
        ts: timeSlot.begin
      }
      return rclient.hsetAsync(this.getKey(), timeKey, JSON.stringify(value))
    })()
  }

  run() {
    this.job();
    setInterval(() => {
      this.job();
    }, this.config.interval || 1000 * 50); // every 50 seconds
  }
}

module.exports = TopTransfer
