/*    Copyright 2016-2022 Firewalla Inc.
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
const sem = require('../sensor/SensorEventManager.js').getInstance();
const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const featureName = "app_time_usage";
const Message = require('../net2/Message.js');
const DomainTrie = require('../util/DomainTrie.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const hourKeyExpires = 86400 * 3;

class AppTimeUsageSensor extends Sensor {
  
  async run() {
    this.hookFeature(featureName);
    this.enabled = fc.isFeatureOn(featureName);
    this.rebuildTrie();

    sem.on(Message.MSG_FLOW_ENRICHED, async (event) => {
      if (event && !_.isEmpty(event.flow))
        await this.processEnrichedFlow(event.flow).catch((err) => {
          log.error(`Failed to process enriched flow`, event.flow, err.message);
        });
    });
  }

  async globalOn() {
    await super.globalOn();
    this.enabled = true;
  }

  async globalOff() {
    await super.globalOff();
    this.enabled = false;
  }

  async onConfigChange(oldConfig) {
    this.rebuildTrie();
  }

  rebuildTrie() {
    const appConfs = this.config.appConfs || {};
    const domainTrie = new DomainTrie();
    for (const key of Object.keys(appConfs)) {
      const includedDomains = appConfs[key].includedDomains || [];
      for (const value of includedDomains) {
        const obj = _.pick(value, ["occupyMins", "lingerMins", "bytesThreshold"]);
        obj.app = key;
        if (value.domain) {
          if (value.domain.startsWith("*.")) {
            domainTrie.add(value.domain.substring(2), obj);
          } else {
            domainTrie.add(value.domain, obj, false);
          }
        }
      }

      // use !<app_key> to mark a domain is excluded from an app
      const excludedDomains = appConfs[key].excludedDomains || [];
      for (const domain of excludedDomains) {
        if (domain.startsWith("*.")) {
          domainTrie.add(domain.substring(2), `!${key}`);
        } else {
          domainTrie.add(domain, `!${key}`, false);
        }
      }
    }
    this._domainTrie = domainTrie;
  }

  // returns an array with matched app criterias
  // [{"app": "youtube", "occupyMins": 1, "lingerMins": 1, "bytesThreshold": 1000000}]
  lookupAppMatch(flow) {
    const domain = flow.host || flow.intel && flow.intel.host;
    const result = [];
    if (!this._domainTrie || !domain)
      return result;
    const values = this._domainTrie.find(domain);
    if (_.isSet(values)) {
      for (const value of values) {
        if (_.isObject(value) && value.app && !values.has(`!${value.app}`))
          result.push(value);
      }
    }
    return result;
  }

  async processEnrichedFlow(enrichedFlow) {
    if (!this.enabled)
      return;
    const appMatches = this.lookupAppMatch(enrichedFlow);
    if (_.isEmpty(appMatches))
      return;
    for (const match of appMatches) {
      const {app, occupyMins, lingerMins, bytesThreshold} = match;
      if (enrichedFlow.ob + enrichedFlow.rb < bytesThreshold)
        continue;
      await this.markBuckets(enrichedFlow.mac, enrichedFlow.tags, enrichedFlow.intf, app, enrichedFlow.ts, enrichedFlow.ts + enrichedFlow.du, occupyMins, lingerMins);
    }
  }

  async markBuckets(mac, tags, intf, app, begin, end, occupyMins, lingerMins) {
    const beginMin = Math.floor(begin / 60);
    const endMin = Math.floor(end / 60) + occupyMins - 1;
    await lock.acquire(`LOCK_${mac}`, async () => {
      const beginHour = Math.floor(beginMin / 60);
      const endHour = Math.floor(endMin / 60);
      const changedKeys = new Set();
      for (let hour = beginHour; hour <= endHour; hour++) {
        const left = (hour === beginHour) ? beginMin % 60 : 0;
        const right = (hour === endHour) ? endMin % 60 : 59;
        for (let minOfHour = left; minOfHour <= right; minOfHour++) {
          const macKey = this.getHourKey(mac, app, hour * 3600);
          const oldValue = await rclient.hgetAsync(macKey, minOfHour);
          await rclient.hsetAsync(macKey, minOfHour, "1");
          changedKeys.add(macKey);
          if (oldValue !== "1") {
            // increment minute bucket usage count on group, network and all device if device bucket is changed to 1
            if (_.isArray(tags)) {
              for (const tag of tags) {
                const key = this.getHourKey(`tag:${tag}`, app, hour * 3600);
                await rclient.hincrbyAsync(key, minOfHour, 1);
                changedKeys.add(key);
              }
            }
            if (!_.isEmpty(intf)) {
              const key = this.getHourKey(`intf:${intf}`, app, hour * 3600);
              await rclient.hincrbyAsync(key, minOfHour, 1);
              changedKeys.add(key);
            }
            const key = this.getHourKey("global", app, hour * 3600);
            await rclient.hincrbyAsync(key, minOfHour, 1);
            changedKeys.add(key);
          }
        }
      }
      // set leading consecutive minute buckets with explicit "0" to "1", because they are in a linger window of a previous session
      for (let min = beginMin - 1; min >= 0; min--) {
        const hour = Math.floor(min / 60);
        const minOfHour = min % 60;
        const macKey = this.getHourKey(mac, app, hour * 3600);
        const oldValue = await rclient.hgetAsync(macKey, minOfHour);
        if (oldValue !== "0")
          break;
        await rclient.hsetAsync(macKey, minOfHour, "1");
        changedKeys.add(macKey);
        if (_.isArray(tags)) {
          for (const tag of tags) {
            const key = this.getHourKey(`tag:${tag}`, app, hour * 3600);
            await rclient.hincrbyAsync(key, minOfHour, 1);
            changedKeys.add(key);
          }
        }
        if (!_.isEmpty(intf)) {
          const key = this.getHourKey(`intf:${intf}`, app, hour * 3600);
          await rclient.hincrbyAsync(key, minOfHour, 1);
          changedKeys.add(key);
        }
        const key = this.getHourKey("global", app, hour * 3600);
        await rclient.hincrbyAsync(key, minOfHour, 1);
        changedKeys.add(key);
      }
      // look ahead trailing lingerMins buckets and set them to "0" or "1" accordingly
      let hour = Math.floor((endMin + lingerMins + 1) / 60);
      let minOfHour = (endMin + lingerMins + 1) % 60;
      let nextVal = await rclient.hgetAsync(this.getHourKey(mac, app, hour * 3600), minOfHour);
      for (let min = endMin + lingerMins; min > endMin; min--) {
        hour = Math.floor(min / 60);
        minOfHour = min % 60;
        const macKey = this.getHourKey(mac, app, hour * 3600);
        const oldValue = await rclient.hgetAsync(macKey, minOfHour);
        if (nextVal !== "1") {
          if (_.isEmpty(oldValue)) {
            await rclient.hsetAsync(macKey, minOfHour, "0");
            changedKeys.add(macKey);
            nextVal = "0";
          } else
            nextVal = oldValue;
        } else {
          await rclient.hsetAsync(macKey, minOfHour, "1");
          changedKeys.add(macKey);
          if (oldValue !== "1") {
            if (_.isArray(tags)) {
              for (const tag of tags) {
                const key = this.getHourKey(`tag:${tag}`, app, hour * 3600);
                await rclient.hincrbyAsync(key, minOfHour, 1);
                changedKeys.add(key);
              }
            }
            if (!_.isEmpty(intf)) {
              const key = this.getHourKey(`intf:${intf}`, app, hour * 3600);
              await rclient.hincrbyAsync(key, minOfHour, 1);
              changedKeys.add(key);
            }
            const key = this.getHourKey("global", app, hour * 3600);
            await rclient.hincrbyAsync(key, minOfHour, 1);
            changedKeys.add(key);
          }
          nextVal = "1";
        }
      }
      for (const key of changedKeys) {
        await rclient.expireAsync(key, hourKeyExpires);
      }
    }).catch((err) => {
      log.error(`Failed to mark minute bucket for ${mac} with app ${app}, begin: ${beginMin}, end: ${endMin}`, err.message);
    });
  }

  getHourKey(uid, app, hour) {
    return `timeUsage:${uid}:app:${app}:${hour}`;
  }

}

module.exports = AppTimeUsageSensor;
