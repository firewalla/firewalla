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
'use strict'

const firewalla = require('../net2/Firewalla.js')
const log = require("../net2/logger.js")(__filename)

const fs = require('fs')
const exec = require('child-process-promise').exec

const Promise = require('bluebird');

const Sensor = require('./Sensor.js').Sensor

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const sem = require('../sensor/SensorEventManager.js').getInstance();

class RuntimeConfigSensor extends Sensor {
  run() {
    async(() => {
      try {
        await (this.updateRedisConfig())
      } catch(err) {
        log.error("Failed to update redis config:", err, {})
      }

      try {
        await (this.updateFakeClock())
      } catch(err) {
        log.error("Failed to record latest time to fake-hwlock:", err, {})
      }
    })()
  }

  updateRedisConfig() {
    // 900 seconds (15min) for one key change
    // 500 seconds (8.3min) for 10 keys change
    // 2 mins for 10000 keys change
    const saveConfig = "900 1 500 10 120 10000"
    return exec(`redis-cli config set save "${saveConfig}"`)
  }

  updateFakeClock() {
    return exec('sudo fake-hwclock')
  }
}

module.exports = RuntimeConfigSensor

