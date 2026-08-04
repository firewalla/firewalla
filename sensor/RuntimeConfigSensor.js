/*    Copyright 2016-2026 Firewalla Inc
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

const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class RuntimeConfigSensor extends Sensor {
  async run() {
    try {
      await this.updateRedisConfig();
      this.runCronScripts();
      await this.schedule();
    } catch(err) {
      log.error("Failed to update redis config:", err);
    }

    setInterval(() => {
      this.schedule()
    }, 3600 * 1000) // update fake hw clock every hour
  }

  async updateRedisConfig() {
    const rdbSize = (await fsp.stat('/data/redis/dump.rdb').then(stat => stat.size)) || 0;
    const saveConfig = platform.getRedisSaveConfig(rdbSize);
    return exec(`redis-cli config set save "${saveConfig}"`)
  }

  runCronScripts() {
    // do not await/block on this
    exec(`sudo ${firewalla.getFirewallaHome()}/scripts/run_cron_scripts.sh`)
      .catch(err => log.error("Failed to run cron scripts:", err.message));
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

