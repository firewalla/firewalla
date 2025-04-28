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
const sysManager = require('../net2/SysManager.js');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));
const Constants = require("../net2/Constants.js");
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

class TimeUsageTool {
  constructor() {
    if (f.isMain() || f.isApi()) {
      this.changedKeys = new Set();

      setInterval(async () => {
        for (const key of this.changedKeys) {
          await rclient.expireAsync(key, 86400 * 7);
        }
        this.changedKeys.clear();
      }, 300 * 1000);
    }
  }

  async getSupportedApps() {
    const apps = await rclient.smembersAsync(Constants.REDIS_KEY_APP_TIME_USAGE_APPS) || [];
    return apps;
  }

  async getAppCategory(app) {
    const category = await rclient.hgetAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CATEGORY, app);
    return category;
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
    const endMin = Math.floor((end - 1) / 60); // end excluded
    const beginHour = Math.floor(beginMin / 60);
    const endHour = Math.floor(endMin / 60);
    const hours = [];
    for (let hour = beginHour; hour <= endHour; hour++)
      hours.push(hour);
    await Promise.all(hours.map(async (hour) => {
      const buckets = await this.getHourBuckets(uid, app, hour);
      for (let minOfHour = (hour === beginHour ? beginMin % 60 : 0); minOfHour <= (hour === endHour ? endMin % 60 : 59); minOfHour++) {
        if (!isNaN(buckets[`${minOfHour}`]) && buckets[`${minOfHour}`] > 0) {
          const key = granularity === "hour" ? `${hour * 3600}` : `${hour * 3600 + minOfHour * 60}`;
          result[key] = (result[key] || 0) + Number(buckets[minOfHour]);
        }
      }
    }));
    return result;
  }

  async getFilledBucketsCount(uid, apps, begin, end, uniqueMinute = false) {
    let result = 0;
    const beginMin = Math.floor(begin / 60);
    const endMin = Math.floor((end - 1) / 60); // end excluded
    const beginHour = Math.floor(beginMin / 60);
    const endHour = Math.floor(endMin / 60);
    for (let hour = beginHour; hour <= endHour; hour++) {
      const buckets = await Promise.all(apps.map(app => this.getHourBuckets(uid, app, hour))).then(results => results.reduce((total, cur) => {
        for (const k of Object.keys(cur))
          total[k] = (!isNaN(total[k]) ? Number(total[k]) : 0) + (!isNaN(cur[k]) ? Number(cur[k]) : 0);
        return total;
      }, {}));
      for (let minOfHour = (hour === beginHour ? beginMin % 60 : 0); minOfHour <= (hour === endHour ? endMin % 60 : 59); minOfHour++) {
        if (!isNaN(buckets[`${minOfHour}`]) && buckets[`${minOfHour}`] > 0) {
          result += (uniqueMinute ? 1 : Number(buckets[minOfHour]));
        }
      }
    }
    return result;
  }

  async recordUIDAssociation(containerKey, elementKey, hour) {
    const key = `assoc:${containerKey}:${hour * 3600}`;
    await rclient.saddAsync(key, elementKey);
    this.changedKeys.add(key);
  }

  // begin included, end excluded
  async getUIDAssociation(containerKey, begin, end) {
    const beginHour = Math.floor(begin / 3600);
    const endHour = Math.floor((end - 1) / 3600);
    const elems = {};
    for (let hour = beginHour; hour <= endHour; hour++) {
      const key = `assoc:${containerKey}:${hour * 3600}`;
      const uids = await rclient.smembersAsync(key) || [];
      for (const uid of uids)
        elems[uid] = 1;
    }
    return Object.keys(elems);
  }

  // begin included, end excluded
  async getAppTimeUsageStats(uid, containerUid, apps = [], begin, end, granularity, uidIsDevice = false, includeSlots = true, includeIntervals = true) {
    const macs = uidIsDevice ? [uid] : await this.getUIDAssociation(uid, begin, end);
    const timezone = sysManager.getTimezone();
    const appTimeUsage = {};
    const appTimeUsageTotal = {slots: {}};
    const totalBuckets = {};
    const categoryTimeUsage = {};
    const categoriesBuckets = {};

    let beginSlot = null;
    let slotLen = null;
    switch (granularity) {
      case "day":
        slotLen = 86400;
        beginSlot = moment.unix(begin).tz(timezone).startOf("day").unix();
        break;
      case "hour":
        slotLen = 3600;
        beginSlot = moment.unix(begin).tz(timezone).startOf("hour").unix();
        break;
      default:
        if (granularity)
          log.warn(`Unsupported granularity ${granularity}, will not return slots data`);
    }

    if (beginSlot && slotLen) {
      const slots = {};
      appTimeUsageTotal.slots = slots;
      for (let slot = beginSlot; slot < end; slot += slotLen)
        slots[slot] = { totalMins: 0, uniqueMins: 0 };
    }

    await Promise.all(apps.map(async (app) => {
      const buckets = await this.getFilledBuckets(containerUid ? `${uid}@${containerUid}` : uid, app, begin, end, "minute");
      const appResult = {};
      const category = await this.getAppCategory(app) || "none"; // categorize an app into a placeholder category, UI may it as "Other" in category-level drill down
      appResult.category = category;
      if (!categoryTimeUsage.hasOwnProperty(category))
        categoryTimeUsage[category] = {slots: {}, totalMins: 0, uniqueMins: 0};
      if (!categoriesBuckets.hasOwnProperty(category))
        categoriesBuckets[category] = {};
      const categoryBuckets = categoriesBuckets[category];
      const categoryResult = categoryTimeUsage[category];

      const bucketKeys = Object.keys(buckets);
      if (beginSlot && slotLen) {
        const slots = {};
        appResult.slots = slots;
        for (let slot = beginSlot; slot < end; slot += slotLen)
          slots[slot] = { totalMins: 0, uniqueMins: 0 };
        for (const key of bucketKeys) {
          const slot = String(Math.floor((Number(key) - beginSlot) / slotLen) * slotLen + beginSlot);
          if (!slots.hasOwnProperty(slot))
            slots[slot] = { totalMins: 0, uniqueMins: 0 };
          slots[slot].totalMins += buckets[key];
          slots[slot].uniqueMins++;
          await lock.acquire(`LOCK_APP_TOTAL_${slot}`, async () => {
            if (!appTimeUsageTotal.slots.hasOwnProperty(slot))
              appTimeUsageTotal.slots[slot] = { totalMins: 0, uniqueMins: 0 };
            appTimeUsageTotal.slots[slot].totalMins += buckets[key];
            if (!totalBuckets.hasOwnProperty(key)) {
              totalBuckets[key] = buckets[key];
              appTimeUsageTotal.slots[slot].uniqueMins++;
            } else
              totalBuckets[key] += buckets[key];
          });

          await lock.acquire(`LOCK_CATEGORY_TOTAL_${category}_${slot}`, async () => {
            if (!categoryResult.slots.hasOwnProperty(slot))
              categoryResult.slots[slot] = { totalMins: 0, uniqueMins: 0 };
            categoryResult.slots[slot].totalMins += buckets[key];
            categoryResult.totalMins += buckets[key];
            if (!categoryBuckets.hasOwnProperty(key)) {
              categoryBuckets[key] = buckets[key];
              categoryResult.slots[slot].uniqueMins++;
              categoryResult.uniqueMins++;
            } else
              categoryBuckets[key] += buckets[key];
          });
        }
      }
      appResult.totalMins = bucketKeys.reduce((v, k) => v + buckets[k], 0);
      appResult.uniqueMins = bucketKeys.length;
  
      appResult.devices = {};
      if (_.isArray(macs)) {
        await Promise.all(macs.map(async (mac) => {
          const buckets = await this.getFilledBuckets((uidIsDevice || uid === "global") ? (containerUid ? `${mac}@${containerUid}` : mac) : `${mac}@${uid}`, app, begin, end, "minute"); // use device-tag or device-intf associated key to query
          const bucketKeys = Object.keys(buckets);
          const totalMins = bucketKeys.reduce((v, k) => v + buckets[k], 0);
          const uniqueMins = bucketKeys.length;
          if (includeIntervals) {
            const intervals = this._minuteBucketsToIntervals(buckets);
            if (!_.isEmpty(intervals))
              appResult.devices[mac] = { intervals, totalMins, uniqueMins };
          }
        }))
      }
      if (!includeSlots)
        delete appResult.slots;
      appTimeUsage[app] = appResult;
    }));
    const totalBucketKeys = Object.keys(totalBuckets);
    appTimeUsageTotal.totalMins = totalBucketKeys.reduce((v, k) => v + totalBuckets[k], 0);
    appTimeUsageTotal.uniqueMins = totalBucketKeys.length;
    if (!includeSlots) {
      delete appTimeUsageTotal.slots;
      for (const category of Object.keys(categoryTimeUsage))
        delete categoryTimeUsage[category].slots;
    }
    return {appTimeUsage, appTimeUsageTotal, categoryTimeUsage};
  }

  _minuteBucketsToIntervals(buckets) {
    const intervals = [];
    let cur = null;
    const sortedKeys = Object.keys(buckets).map(Number).sort();
    for (const key of sortedKeys) {
      if (cur == null || key - cur.end > 60) {
        cur = { begin: key, end: key };
        intervals.push(cur);
      } else {
        cur.end = key;
      }
    }
    return intervals;
  }
}

module.exports = new TimeUsageTool();