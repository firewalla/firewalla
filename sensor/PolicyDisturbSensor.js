/*    Copyright 2016-2025 Firewalla Inc.
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
const _ = require('lodash');
const CronJob = require('cron').CronJob;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const fc = require('../net2/config.js');
const featureName = "policy_disturb";
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');
const bone = require("../lib/Bone.js");
const CLOUD_CONFIG_KEY = Constants.REDIS_KEY_POLICY_DISTURB_CLOUD_CONFIG;
const SysManager = require('../net2/SysManager.js');


class PolicyDisturbSensor extends Sensor {

  async run() {
    this.cloudConfig = null; // for app time usage config
    this.disturbConfs = {};
    await this.loadConfig(true);

    await this.scheduleUpdateConfigCronJob();

    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info("System timezone is reloaded, will reschedule update config cron job ...");
        await this.scheduleUpdateConfigCronJob();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
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
    }, () => { }, true, tz);
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load policy disturb config from cloud`, err.message);
    });
    this.disturbConfs = Object.assign({}, _.get(this.config, "disturbConfs", {}), _.get(this.cloudConfig, "disturbConfs", {}));
    if (this.disturbConfs && !_.isEmpty(this.disturbConfs))
      sem.emitLocalEvent({ type: Message.MSG_APP_DISTURB_VALUE_UPDATED, disturbConfs: this.disturbConfs, suppressEventLogging: true });
  }

  async loadCloudConfig(reload = false) {
    // cat policy_disturb_config | jq -c .| redis-cli -x SET policy_disturb_cloud_config
    let policyDisturbConfig = await rclient.getAsync(CLOUD_CONFIG_KEY).then(result => result && JSON.parse(result)).catch(err => null);
    this.cloudConfig = policyDisturbConfig;
    if (_.isEmpty(policyDisturbConfig) || reload) {
      policyDisturbConfig = await bone.hashsetAsync(Constants.REDIS_KEY_POLICY_DISTURB_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
      if (!_.isEmpty(policyDisturbConfig) && _.isObject(policyDisturbConfig)) {
        await rclient.setAsync(CLOUD_CONFIG_KEY, JSON.stringify(policyDisturbConfig));
        this.cloudConfig = policyDisturbConfig;
      }
    }
  }

}

module.exports = PolicyDisturbSensor;
