/*    Copyright 2016-2023 Firewalla Inc.
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
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');
const bone = require("../lib/Bone.js");
const { BloomFilter } = require('../vendor_lib/bloomfilter.js');
const SysManager = require('../net2/SysManager.js');
const CLOUD_CONFIG_KEY = Constants.REDIS_KEY_NOISE_DOMAIN_CLOUD_CONFIG;
const CronJob = require('cron').CronJob;

class NoiseDomainsSensor extends Sensor {
  async run() {
    return this.init();
  }

  async apiRun() {
    return this.init();
  }
  
  async init() {
    this.bloomfilter = null;
    await this.reloadDomains(true);
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
        await this.reloadDomains(true).catch((err) => {
          log.error(`Failed to load noise domains from cloud `, err.message);
        });
      }, delayMins * 60 * 1000);
    }, () => { }, true, tz);
  }

  async reloadDomains(forceReload = false) {
    try {
      let bf_content = await rclient.getAsync(CLOUD_CONFIG_KEY).then(result => result && JSON.parse(result)).catch(err => null);
      this.bloomfilter = new BloomFilter(this._decodeArrayOfIntBase64(bf_content.buckets), bf_content.k);
      if (_.isEmpty(bf_content) || forceReload) {
        bf_content = await bone.hashsetAsync(Constants.REDIS_KEY_NOISE_DOMAIN_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
        if (!_.isEmpty(bf_content) && _.isObject(bf_content)) {
          await rclient.setAsync(CLOUD_CONFIG_KEY, JSON.stringify(bf_content));
          this.bloomfilter = new BloomFilter(this._decodeArrayOfIntBase64(bf_content.buckets), bf_content.k);
        }
      }
    } catch (err) {
      log.error(`Failed to load noise domain config from cloud`, err.message);
    }
  }
 
  _decodeArrayOfIntBase64(s) {
    const buf = Buffer.from(s, 'base64');
    const arr = [];
    for (let i = 0; i < buf.length; i += 4) {
      arr.push(buf.readInt32LE(i));
    }
    return arr;
  }

  find(domain, isIP = false) {
    if(!domain || !this.bloomfilter) {
      return new Set();
    }
    if (isIP) {
      return this.bloomfilter.test(domain) ? new Set(["noise"]) : new Set();
    }
    const reversedParts = domain.split('.').reverse();
    for (let i = reversedParts.length - 1; i >= 0; i--) {
      const subDomain = reversedParts.slice(0, i + 1).reverse().join('.');
      if(this.bloomfilter.test(subDomain)) {
        return new Set(["noise"]);
      }
    }
    return new Set();
  }
}

module.exports = NoiseDomainsSensor;
