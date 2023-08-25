/*    Copyright 2023 Firewalla Inc.
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

const log = require("../net2/logger.js")(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');
const _ = require('lodash');

class TimeUsageTool {
  constructor() {
    if (f.isMain()) {
      this.changedKeys = new Set();

      setInterval(async () => {
        for (const key of this.changedKeys) {
          await rclient.expireAsync(key, 86400 * 3);
        }
        this.changedKeys.clear();
      }, 300 * 1000);
    }
  }

  getSupportedApps() {
    const fConfig = require('../net2/config.js').getConfig();
    return Object.keys(_.get(fConfig, ["sensors", "AppTimeUsageSensor", "appConfs"]) || {});
  }

  getHourKey(uid, app, hour) {
    return `timeUsage:${uid}:app:${app}:${hour}`;
  }

  async getBucketVal(uid, app, hour, minOfHour) {
    const key = this.getHourKey(uid, app, hour * 3600);
    const value = await rclient.hgetAsync(key, minOfHour);
    return value;
  }

  async setBucketVal(uid, app, hour, minOfHour, value) {
    const key = this.getHourKey(uid, app, hour * 3600);
    await rclient.hsetAsync(key, minOfHour, value);
    this.changedKeys.add(key);
  }

  async incrBucketVal(uid, app, hour, minOfHour) {
    const key = this.getHourKey(uid, app, hour * 3600);
    await rclient.hincrbyAsync(key, minOfHour, 1);
    this.changedKeys.add(key);
  }

  async getHourBuckets(uid, app, hour) {
    const key = this.getHourKey(uid, app, hour * 3600);
    const value = await rclient.hgetallAsync(key);
    return value || {};
  }

  async getFilledBuckets(uid, app, begin, end, granularity = "hour") {
    const result = {};
    const beginMin = Math.floor(begin / 60);
    const endMin = Math.floor(end / 60);
    const beginHour = Math.floor(beginMin / 60);
    const endHour = Math.floor(endMin / 60);
    for (let hour = beginHour; hour <= endHour; hour++) {
      const buckets = await this.getHourBuckets(uid, app, hour);
      for (let minOfHour = (hour === beginHour ? beginMin % 60 : 0); minOfHour <= (hour === endHour ? endMin % 60 : 59); minOfHour++) {
        if (!isNaN(buckets[`${minOfHour}`]) && buckets[`${minOfHour}`] > 0) {
          const key = granularity === "hour" ? `${hour * 3600}` : `${hour * 3600 + minOfHour * 60}`;
          result[key] = (result[key] || 0) + Number(buckets[minOfHour]);
        }
      }
    }
    return result;
  }

  async getFilledBucketsCount(uid, app, begin, end, uniqueMinute = false) {
    let result = 0;
    const beginMin = Math.floor(begin / 60);
    const endMin = Math.floor(end / 60);
    const beginHour = Math.floor(beginMin / 60);
    const endHour = Math.floor(endMin / 60);
    for (let hour = beginHour; hour <= endHour; hour++) {
      const buckets = await this.getHourBuckets(uid, app, hour);
      for (let minOfHour = (hour === beginHour ? beginMin % 60 : 0); minOfHour <= (hour === endHour ? endMin % 60 : 59); minOfHour++) {
        if (!isNaN(buckets[`${minOfHour}`]) && buckets[`${minOfHour}`] > 0) {
          result += (uniqueMinute ? 1 : Number(buckets[minOfHour]));
        }
      }
    }
    return result;
  }
}

module.exports = new TimeUsageTool();