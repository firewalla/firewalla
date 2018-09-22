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

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

class RuntimeConfigSensor extends Sensor {
  async run() {
    try {
      await this.updateRedisConfig();
      await this.schedule();
    } catch(err) {
      log.error("Failed to update redis config:", err, {})
    }

    setInterval(() => {
      this.schedule()
    }, 3600 * 1000) // update fake hw clock every hour
  }

  async updateRedisConfig() {
    // 900 seconds (15min) for one key change
    // 500 seconds (8.3min) for 10 keys change
    // 2 mins for 10000 keys change
    const saveConfig = "900 10 500 100 120 100000"
    return exec(`redis-cli config set save "${saveConfig}"`)
  }

  async schedule() {
    try {
      await this.updateFakeClock();
    } catch(err) {
      log.error("Failed to record latest time to fake-hwlock:", err, {})
    }
  }

  async updateFakeClock() {
    return exec('sudo fake-hwclock');
  }
}

module.exports = RuntimeConfigSensor

