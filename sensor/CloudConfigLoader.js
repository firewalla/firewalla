/*    Copyright 2026 Firewalla Inc.
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

const _ = require('lodash');
const CronJob = require('cron').CronJob;
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const bone = require('../lib/Bone.js');
const SysManager = require('../net2/SysManager.js');

// A sensor setting fetched from a cloud hashset, cached in redis under cacheKey, and pulled again
// once a day. apply(cloudConfig) is called with the cached or fetched config, null when there's none
class CloudConfigLoader {
  constructor({ cacheKey, hashsetName, label, apply }) {
    this.cacheKey = cacheKey;
    this.hashsetName = hashsetName;
    this.label = label;
    this.apply = apply;
    this.cloudConfig = null;
  }

  async start() {
    await this.reloadNow();
    this._scheduleCron();

    sclient.on("message", (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info(`System timezone is reloaded, will reschedule ${this.label} config cron job ...`);
        this._scheduleCron();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
  }

  // fetch from the cloud and apply
  async reloadNow() {
    await this._load(true);
    await this.apply(this.cloudConfig);
  }

  // apply the cached config, fetching only when there's no cache
  async refresh() {
    await this._load(false);
    await this.apply(this.cloudConfig);
  }

  _scheduleCron() {
    if (this.reloadJob)
      this.reloadJob.stop();
    if (this.reloadTimeout)
      clearTimeout(this.reloadTimeout);
    const tz = SysManager.getTimezone();
    this.reloadJob = new CronJob("30 23 * * *", async () => { // pull cloud config once every day, the request is sent between 23:30 to 00:00 to avoid calling cloud at the same time
      const delayMins = Math.random() * 30;
      this.reloadTimeout = setTimeout(async () => {
        await this.reloadNow().catch((err) => {
          log.error(`Failed to load ${this.label} cloud config`, err.message);
        });
      }, delayMins * 60 * 1000);
    }, () => { }, true, tz);
  }

  async _load(reload) {
    try {
      let cfg = await rclient.getAsync(this.cacheKey).then(r => r && JSON.parse(r)).catch(() => null);
      this.cloudConfig = cfg;
      if (_.isEmpty(cfg) || reload) {
        cfg = await bone.hashsetAsync(this.hashsetName).then(r => r && JSON.parse(r)).catch(() => null);
        if (!_.isEmpty(cfg) && _.isObject(cfg)) {
          await rclient.setAsync(this.cacheKey, JSON.stringify(cfg));
          this.cloudConfig = cfg;
        }
      }
    } catch (err) {
      log.error(`Failed to load ${this.label} config from cloud`, err.message);
    }
  }
}

module.exports = CloudConfigLoader;
