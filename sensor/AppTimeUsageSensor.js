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
const featureName = "app_time_usage";
const Message = require('../net2/Message.js');
const DomainTrie = require('../util/DomainTrie.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const TimeUsageTool = require('../flow/TimeUsageTool.js');

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

  // a per-device lock should be acquired before calling this function
  async _incrBucketHierarchy(mac, tags, intf, app, hour, minOfHour) {
    await TimeUsageTool.setBucketVal(mac, app, hour, minOfHour, "1");
    // increment minute bucket usage count on group, network and all device if device bucket is changed to 1
    if (_.isArray(tags)) {
      for (const tag of tags) {
        await TimeUsageTool.incrBucketVal(`tag:${tag}`, app, hour, minOfHour);
      }
    }
    if (!_.isEmpty(intf)) {
      await TimeUsageTool.incrBucketVal(`intf:${intf}`, app, hour, minOfHour);
    }
    await TimeUsageTool.incrBucketVal("global", app, hour, minOfHour);
  }

  async markBuckets(mac, tags, intf, app, begin, end, occupyMins, lingerMins) {
    const beginMin = Math.floor(begin / 60);
    const endMin = Math.floor(end / 60) + occupyMins - 1;
    await lock.acquire(`LOCK_${mac}`, async () => {
      const beginHour = Math.floor(beginMin / 60);
      const endHour = Math.floor(endMin / 60);
      for (let hour = beginHour; hour <= endHour; hour++) {
        const left = (hour === beginHour) ? beginMin % 60 : 0;
        const right = (hour === endHour) ? endMin % 60 : 59;
        for (let minOfHour = left; minOfHour <= right; minOfHour++) {
          const oldValue = await TimeUsageTool.getBucketVal(mac, app, hour, minOfHour);
          if (oldValue !== "1") {
            // set minute bucket on device to 1, and increment minute bucket on group, network and all device
            await this._incrBucketHierarchy(mac, tags, intf, app, hour, minOfHour);
          }
        }
      }
      // set leading consecutive minute buckets with explicit "0" to "1", because they are in a linger window of a previous session
      for (let min = beginMin - 1; min >= 0; min--) {
        const hour = Math.floor(min / 60);
        const minOfHour = min % 60;
        const oldValue = await TimeUsageTool.getBucketVal(mac, app, hour, minOfHour);
        if (oldValue !== "0")
          break;
        await this._incrBucketHierarchy(mac, tags, intf, app, hour, minOfHour);
      }
      // look ahead trailing lingerMins buckets and set them to "0" or "1" accordingly
      let hour = Math.floor((endMin + lingerMins + 1) / 60);
      let minOfHour = (endMin + lingerMins + 1) % 60;
      let nextVal = await TimeUsageTool.getBucketVal(mac, app, hour, minOfHour);
      for (let min = endMin + lingerMins; min > endMin; min--) {
        hour = Math.floor(min / 60);
        minOfHour = min % 60;
        const oldValue = await TimeUsageTool.getBucketVal(mac, app, hour, minOfHour);
        if (nextVal !== "1") {
          if (_.isEmpty(oldValue)) {
            await TimeUsageTool.setBucketVal(mac, app, hour, minOfHour, "0");
            nextVal = "0";
          } else
            nextVal = oldValue;
        } else {
          if (oldValue !== "1") {
            await this._incrBucketHierarchy(mac, tags, intf, app, hour, minOfHour);
          }
          nextVal = "1";
        }
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
