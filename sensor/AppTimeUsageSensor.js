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
const CronJob = require('cron').CronJob;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const fc = require('../net2/config.js');
const featureName = "app_time_usage";
const Message = require('../net2/Message.js');
const DomainTrie = require('../util/DomainTrie.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const TimeUsageTool = require('../flow/TimeUsageTool.js');
const DNSTool = require('../net2/DNSTool.js');
const Constants = require('../net2/Constants.js');
const dnsTool = new DNSTool();
const bone = require("../lib/Bone.js");
const SysManager = require('../net2/SysManager.js');
const CLOUD_CONFIG_KEY = "app_time_usage_cloud_config";

class AppTimeUsageSensor extends Sensor {
  
  async run() {
    this.hookFeature(featureName);
    this.enabled = fc.isFeatureOn(featureName);
    this.cloudConfig = null;
    await this.loadConfig();

    await this.scheduleUpdateConfigCronJob();

    sem.on(Message.MSG_FLOW_ENRICHED, async (event) => {
      if (event && !_.isEmpty(event.flow))
        await this.processEnrichedFlow(event.flow).catch((err) => {
          log.error(`Failed to process enriched flow`, event.flow, err.message);
        });
    });

    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        if (this._policy) {
          log.info("System timezone is reloaded, will reschedule update config cron job ...");
          await this.scheduleUpdateConfigCronJob();
        }
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
      }, delayMins * 1000);
    }, () => {}, true, tz);
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load app time usage config from cloud`, err.message);
    });
    await this.updateSupportedApps();
    this.rebuildTrie();
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
    await this.updateSupportedApps();
    this.rebuildTrie();
  }

  async loadCloudConfig(reload = false) {
    let data = await rclient.getAsync(CLOUD_CONFIG_KEY).then(result => result && JSON.parse(result)).catch(err => null);
    this.cloudConfig = data;
    if (_.isEmpty(data) || reload)
      data = await bone.hashsetAsync("app_time_usage_config").catch((err) => null);
    if (!_.isEmpty(data) && _.isObject(data)) {
      await rclient.setAsync(CLOUD_CONFIG_KEY, JSON.stringify(data));
      this.cloudConfig = data;
    }
  }

  async updateSupportedApps() {
    const appConfs = Object.assign({}, _.get(this.config, "appConfs", {}), _.get(this.cloudConfig, "appConfs", {}));
    const apps = Object.keys(appConfs);
    await rclient.delAsync(Constants.REDIS_KEY_APP_TIME_USAGE_APPS);
    await rclient.saddAsync(Constants.REDIS_KEY_APP_TIME_USAGE_APPS, apps);
    for (const app of apps) {
      const {category} = appConfs[app];
      if (category)
        await rclient.hsetAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CATEGORY, app, category);
      else
        await rclient.hdelAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CATEGORY, app);
    }
  }

  rebuildTrie() {
    const appConfs = Object.assign({}, _.get(this.config, "appConfs", {}), _.get(this.cloudConfig, "appConfs", {}));
    const domainTrie = new DomainTrie();
    for (const key of Object.keys(appConfs)) {
      const includedDomains = appConfs[key].includedDomains || [];
      const category = appConfs[key].category;
      for (const value of includedDomains) {
        const obj = _.pick(value, ["occupyMins", "lingerMins", "bytesThreshold", "minsThreshold"]);
        obj.app = key;
        if (category)
          obj.category = category;
        if (value.domain) {
          if (value.domain.startsWith("*.")) {
            obj.domain = value.domain.substring(2);
            domainTrie.add(value.domain.substring(2), obj);
          } else {
            obj.domain = value.domain;
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
    const host = flow.host || flow.intel && flow.intel.host;
    const result = [];
    if (!this._domainTrie || !host)
      return result;
    const values = this._domainTrie.find(host);
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
    const host = enrichedFlow.host || enrichedFlow.intel && enrichedFlow.intel.host;
    const appMatches = this.lookupAppMatch(enrichedFlow);
    if (_.isEmpty(appMatches))
      return;
    for (const match of appMatches) {
      const {app, category, domain, occupyMins, lingerMins, bytesThreshold, minsThreshold} = match;
      if (host && domain)
        await dnsTool.addSubDomains(domain, [host]);
      if (enrichedFlow.ob + enrichedFlow.rb < bytesThreshold)
        continue;
      let tags = []
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        tags.push(...(enrichedFlow[config.flowKey] || []));
      }
      tags = _.uniq(tags);
      await this.markBuckets(enrichedFlow.mac, tags, enrichedFlow.intf, app, category, enrichedFlow.ts, enrichedFlow.ts + enrichedFlow.du, occupyMins, lingerMins, minsThreshold);
    }
  }

  // a per-device lock should be acquired before calling this function
  async _incrBucketHierarchy(mac, tags, intf, app, category, hour, minOfHour, macOldValue) {
    const appUids = [];
    const categoryUids = [];
    const objs = [{app, uids: appUids}];
    if (category)
      objs.push({app: category, uids: categoryUids});
    if (macOldValue !== "1") {
      for (const obj of objs) {
        const {app, uids} = obj;
        await TimeUsageTool.setBucketVal(mac, app, hour, minOfHour, "1");
        uids.push(mac);
      }
    }
    // increment minute bucket usage count on group, network and all device if device bucket is changed to 1
    if (_.isArray(tags)) {
      for (const tag of tags) {
        await TimeUsageTool.recordUIDAssociation(`tag:${tag}`, mac, hour);
        const assocUid = `${mac}@tag:${tag}`;
        for (const obj of objs) {
          const {app, uids} = obj;
          const oldValue = await TimeUsageTool.getBucketVal(assocUid, app, hour, minOfHour);
          // only increase tag stats if mac-tag association stats on this minute is not set
          if (oldValue !== "1") {
            await TimeUsageTool.setBucketVal(assocUid, app, hour, minOfHour, "1");
            await TimeUsageTool.incrBucketVal(`tag:${tag}`, app, hour, minOfHour);
            uids.push(`tag:${tag}`);
          }
        }
      }
    }
    /* do not update network and global time usage keys because they are not used in real world scenarios, can be re-enabled in the future if necessary
    if (!_.isEmpty(intf)) {
      await TimeUsageTool.recordUIDAssociation(`intf:${intf}`, mac, hour);
      const assocUid = `${mac}@intf:${intf}`;
      for (const obj of objs) {
        const {app, uids} = obj;
        const oldValue = await TimeUsageTool.getBucketVal(assocUid, app, hour, minOfHour);
        // only increase intf stats if mac-intf association stats on this minute is not set
        if (oldValue !== "1") {
          await TimeUsageTool.setBucketVal(assocUid, app, hour, minOfHour, "1");
          await TimeUsageTool.incrBucketVal(`intf:${intf}`, app, hour, minOfHour);
          uids.push(`intf:${intf}`);
        }
      }
    }
    await TimeUsageTool.recordUIDAssociation("global", mac, hour);
    if (macOldValue !== "1") {
      for (const obj of objs) {
        const {app, uids} = obj;
        await TimeUsageTool.incrBucketVal("global", app, hour, minOfHour);
        uids.push("global");
      }
    }
    */
    for (const obj of objs) {
      const {app, uids} = obj;
      sem.emitLocalEvent({type: Message.MSG_APP_TIME_USAGE_BUCKET_INCR, app, uids, suppressEventLogging: true});
    }
  }

  async markBuckets(mac, tags, intf, app, category, begin, end, occupyMins, lingerMins, minsThreshold) {
    const beginMin = Math.floor(begin / 60);
    const endMin = Math.floor(end / 60) + occupyMins - 1;
    await lock.acquire(`LOCK_${mac}`, async () => {
      let extended = false;
      // set leading consecutive minute buckets with explicit "0" to "1", because they are in a linger window of a previous session
      for (let min = beginMin - 1; min >= 0; min--) {
        const hour = Math.floor(min / 60);
        const minOfHour = min % 60;
        const oldValue = await TimeUsageTool.getBucketVal(mac, app, hour, minOfHour);
        if (oldValue !== "0") {
          if (oldValue === "1")
            extended = true;
          break;
        }
        extended = true;
        await this._incrBucketHierarchy(mac, tags, intf, app, category, hour, minOfHour, oldValue);
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
          await this._incrBucketHierarchy(mac, tags, intf, app, category, hour, minOfHour, oldValue);
          nextVal = "1";
          extended = true;
        }
      }

      const effective = endMin - beginMin + 1 >= minsThreshold || extended; // do not record interval less than minsThreshold unless it is adjacent to linger minutes of other intervals
      const beginHour = Math.floor(beginMin / 60);
      const endHour = Math.floor(endMin / 60);
      for (let hour = beginHour; hour <= endHour; hour++) {
        const left = (hour === beginHour) ? beginMin % 60 : 0;
        const right = (hour === endHour) ? endMin % 60 : 59;
        for (let minOfHour = left; minOfHour <= right; minOfHour++) {
          const oldValue = await TimeUsageTool.getBucketVal(mac, app, hour, minOfHour);
          if (effective) {
            // set minute bucket on device to 1, and increment minute bucket on group, network and all device
            await this._incrBucketHierarchy(mac, tags, intf, app, category, hour, minOfHour, oldValue);
          } else {
            if (oldValue !== "1") {
              await TimeUsageTool.setBucketVal(mac, app, hour, minOfHour, "0");
            }
          }
        }
      }
    }).catch((err) => {
      log.error(`Failed to mark minute bucket for ${mac} with app ${app}, begin: ${begin}, end: ${end}`, err.message);
    });
  }

  getHourKey(uid, app, hour) {
    return `timeUsage:${uid}:app:${app}:${hour}`;
  }

}

module.exports = AppTimeUsageSensor;
