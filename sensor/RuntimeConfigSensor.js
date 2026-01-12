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
const _ = require('lodash');
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Constants = require('../net2/Constants.js');
const bone = require("../lib/Bone.js");
const SysManager = require('../net2/SysManager.js');
const CLOUD_CONFIG_KEY = Constants.REDIS_KEY_BGSAVE_CLOUD_CONFIG;
const platform = require('../platform/PlatformLoader.js').getPlatform();
const CronJob = require('cron').CronJob;
const Message = require('../net2/Message.js');
const SysInfo = require('../extension/sysinfo/SysInfo.js');

class RuntimeConfigSensor extends Sensor {
  async run() {
    try {
      await this.loadConfig(true);
      await this.schedule();
    } catch(err) {
      log.error("Failed to update redis config:", err);
    }

    await this.scheduleUpdateConfigCronJob();

    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info("System timezone is reloaded, will reschedule update config cron job ...");
        await this.scheduleUpdateConfigCronJob();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);

    setInterval(() => {
      this.schedule()
    }, 3600 * 1000) // update fake hw clock every hour
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load redis bgsave config from cloud`, err.message);
    });
    if (_.isEqual(this.bgsaveConfig, this.cloudConfig))
      return;

    this.bgsaveConfig = this.cloudConfig;
    await this.updateRedisConfig();
  }

  async loadCloudConfig(reload = false) {
    let bgsaveConfig = await rclient.getAsync(CLOUD_CONFIG_KEY).then(result => result && JSON.parse(result)).catch(err => null);
    this.cloudConfig = bgsaveConfig || {};
    if (_.isEmpty(bgsaveConfig) || reload) {
      bgsaveConfig = await bone.hashsetAsync(Constants.REDIS_KEY_BGSAVE_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
      if (!_.isEmpty(bgsaveConfig) && _.isObject(bgsaveConfig)) {
        await rclient.setAsync(CLOUD_CONFIG_KEY, JSON.stringify(bgsaveConfig));
        this.cloudConfig = bgsaveConfig;
      }
    }
  }

  async scheduleUpdateConfigCronJob() {
    if (this.reloadJob)
      this.reloadJob.stop();
    if (this.reloadTimeout)
      clearTimeout(this.reloadTimeout);
    const tz = SysManager.getTimezone();
    this.reloadJob = new CronJob("30 23 * * *", async () => { // pull cloud config once every day, the request is sent between 23:30 to 00:00 to avoid calling cloud at the same time
      const delayMins = Math.random() * 30;
      this.reloadTimeout = setTimeout(async () => {
        await this.loadConfig(true).catch((err) => {
          log.error(`Failed to load cloud config`, err.message);
        });
      }, delayMins * 60 * 1000);
    }, () => {}, true, tz);
  }
  

  async updateRedisConfig() {
    // 900 seconds (15min) for 10 key change
    // 600 seconds (10min) for 1000 keys change
    // 5 mins for 100000 keys change
    let saveConfig = "900 10 600 1000 300 100000"
    const platformName = platform.getName();
    const rdbSize = (await fsp.stat('/data/redis/dump.rdb').then(stat => stat.size)) || 0;

    const emmcDisk = await SysInfo.getEmmcDiskName();
    //Absence of emmcDisk indicates a non-eMMC medium (e.g., Goldv2 SSD); apply default settings.
    if (emmcDisk && this.bgsaveConfig && !_.isEmpty(this.bgsaveConfig)) {
      const configMap = this.bgsaveConfig[platformName] || this.bgsaveConfig['default'] || {};
      const sortedRules = Object.values(configMap).sort((a, b) => b.limit - a.limit);
      for (const rule of sortedRules) {
        if (rdbSize >= rule.limit) {
          saveConfig = rule.save;
          break;
        }
      }
    }
    if (this.saveConfig !== saveConfig) {
      this.saveConfig = saveConfig;
      await exec(`redis-cli config set save "${saveConfig}"`);
    }
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

