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

const fsp = require('fs').promises;
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
      log.error("Failed to update redis config:", err);
    }

    setInterval(() => {
      this.schedule()
    }, 3600 * 1000) // update fake hw clock every hour
  }

  async updateRedisConfig() {
    // 900 seconds (15min) for 10 key change
    // 600 seconds (10min) for 1000 keys change
    // 5 mins for 100000 keys change
    let saveConfig = "900 10 600 1000 300 100000"

    const rdbSize = (await fsp.stat('/data/redis/dump.rdb').then(stat => stat.size)) || 0;
    if (rdbSize > 52428800 && rdbSize <= 209715200) {
      // rdb size is between 50MB and 200MB
      saveConfig = "1800 20 1200 2000 600 200000"
    } else if (rdbSize > 209715200) {
      // rdb size is greater than 200MB
      saveConfig = "3600 40 2400 4000 1200 400000"
    }

    return exec(`redis-cli config set save "${saveConfig}"`)
  }

  async schedule() {
    await this.updateFakeClock().catch(err => log.error("Failed to record latest time to fake-hwlock:", err.message));
    await this.updateRedisConfig().catch(err => log.error("Failed to update redis RDB save config:", err.message));
  }

  async updateFakeClock() {
    return exec('sudo FILE=/data/fake-hwclock.data fake-hwclock');
  }
}

module.exports = RuntimeConfigSensor

