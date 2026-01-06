/*    Copyright 2016-2024 Firewalla Inc.
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
const CLOUD_CONFIG_KEY = Constants.REDIS_KEY_APP_TIME_USAGE_CLOUD_CONFIG;
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();
const sl = require('../sensor/SensorLoader.js');
const pclient = require('../util/redis_manager.js').getPublishClient()
const firewalla = require("../net2/Firewalla.js");
const CIDRTrie = require('../util/CIDRTrie.js');
const { Address4, Address6 } = require('ip-address');

class AppTimeUsageSensor extends Sensor {
  
  async run() {
    this.hookFeature(featureName);
    this.enabled = fc.isFeatureOn(featureName);
    this.cloudConfig = null; // for app time usage config
    this.internetTimeUsageCfg = null;
    this.appConfs = {};
    await this.loadConfig(true);

    await this.scheduleUpdateConfigCronJob();

    sem.on(Message.MSG_FLOW_ENRICHED, async (event) => {
      if (event && !_.isEmpty(event.flow) && !event.flow.local)
        await this.processEnrichedFlow(event.flow).catch((err) => {
          log.error(`Failed to process enriched flow`, event.flow, err.message);
        });
    });

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
    }, () => {}, true, tz);
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load app time usage config from cloud`, err.message);
    });
    this.appConfs = Object.assign({}, _.get(this.config, "appConfs", {}), _.get(this.cloudConfig, "appConfs", {}));
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
    this.appConfs = Object.assign({}, _.get(this.config, "appConfs", {}), _.get(this.cloudConfig, "appConfs", {}));
    await this.updateSupportedApps();
    this.rebuildTrie();
  }

  async loadCloudConfig(reload = false) {
    let isCloudConfigUpdated = false;
    let appTimeUsageConfig = await rclient.getAsync(CLOUD_CONFIG_KEY).then(result => result && JSON.parse(result)).catch(err => null);
    this.cloudConfig = appTimeUsageConfig;
    if (_.isEmpty(appTimeUsageConfig) || reload) {
      appTimeUsageConfig = await bone.hashsetAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
      if (!_.isEmpty(appTimeUsageConfig) && _.isObject(appTimeUsageConfig)) {
        await rclient.setAsync(CLOUD_CONFIG_KEY, JSON.stringify(appTimeUsageConfig));
        this.cloudConfig = appTimeUsageConfig;
        isCloudConfigUpdated = true;
      }
    }
    let internetTimeUsageCfg = await rclient.getAsync(Constants.REDIS_KEY_INTERNET_TIME_USAGE_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);
    this.internetTimeUsageCfg = internetTimeUsageCfg;
    if (_.isEmpty(internetTimeUsageCfg) || reload) {
      internetTimeUsageCfg = await bone.hashsetAsync(Constants.REDIS_KEY_INTERNET_TIME_USAGE_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
      if (!_.isEmpty(internetTimeUsageCfg) && _.isObject(internetTimeUsageCfg)) {
        await rclient.setAsync(Constants.REDIS_KEY_INTERNET_TIME_USAGE_CONFIG, JSON.stringify(internetTimeUsageCfg));
        this.internetTimeUsageCfg = internetTimeUsageCfg;
        isCloudConfigUpdated = true;
      }
    }

    if (isCloudConfigUpdated) {
      sem.sendEventToAll({type: Message.MSG_APP_INTEL_CONFIG_UPDATED});
    }
  }

  async updateSupportedApps() {
    const appConfs = this.appConfs;
    const apps = Object.keys(appConfs).filter(app => !_.isEmpty(_.get(appConfs, [app, "includedDomains"])));
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
    const appConfs = this.appConfs;
    const domainTrie = new DomainTrie();
    const cidr4Trie = new CIDRTrie(4);
    const cidr6Trie = new CIDRTrie(6);
    const sigMap = new Map();

    for (const key of Object.keys(appConfs)) {
      const includedDomains = appConfs[key].includedDomains || [];
      const category = appConfs[key].category;
      for (const value of includedDomains) {
        const obj = _.pick(value, ["occupyMins", "lingerMins", "bytesThreshold", "minsThreshold", "ulDlRatioThreshold", "noStray", "portInfo"]);
        obj.app = key;
        if (category)
          obj.category = category;

        const id = value.domain || value.cidr;
        if (id) {
          if (new Address4(id).isValid()) {
            obj.domain = id;
            cidr4Trie.add(id, obj);
          } else if (new Address6(id).isValid()) {
            obj.domain = id;
            cidr6Trie.add(id, obj);
          } else {
            if (id.startsWith("*.")) {
              obj.domain = id.substring(2);
              domainTrie.add(id.substring(2), obj);
            } else {
              obj.domain = id;
              domainTrie.add(id, obj, false);
            }
          }
        }
        const sigId = value.sigId;
        if (sigId) {
          sigMap.set(sigId, obj);
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
    this._cidr4Trie = cidr4Trie;
    this._cidr6Trie = cidr6Trie;
    this._sigMap = sigMap;
  }

  getCategoryBytesThreshold(category) {
    if (category && this.internetTimeUsageCfg) {
      if (this.internetTimeUsageCfg[category] &&
        typeof this.internetTimeUsageCfg[category].bytesThreshold === "number")
        return this.internetTimeUsageCfg[category].bytesThreshold;
      if (this.internetTimeUsageCfg["default"] &&
        typeof this.internetTimeUsageCfg["default"].bytesThreshold === "number")
        return this.internetTimeUsageCfg["default"].bytesThreshold;
    }
    return 200 * 1024; // default threshold is 200KB
  }

  getCategoryUlDlRatioThreshold(category) {
    if (category && this.internetTimeUsageCfg) {
      if (this.internetTimeUsageCfg[category] &&
        typeof this.internetTimeUsageCfg[category].ulDlRatioThreshold === "number")
        return this.internetTimeUsageCfg[category].ulDlRatioThreshold;
      if (this.internetTimeUsageCfg["default"] &&
        typeof this.internetTimeUsageCfg["default"].ulDlRatioThreshold === "number")
        return this.internetTimeUsageCfg["default"].ulDlRatioThreshold;
    }
    return 5; // default threshold is 5
  }
  
  recordFlow(flow) {
    pclient.publishAsync("internet.activity.flow", JSON.stringify({flow}));
  }

  async recordFlow2Redis(flow, app) {
    if (!fc.isFeatureOn("record_activity_flow")){
      return;
    }
    const date = new Date(flow.ts * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const formattedDate = `${year}${month}${day}`;
    const appName =  app || "internet";
    const key = `internet_flows:${appName}:${flow.mac}:${formattedDate}`;
    const host = flow.host || flow.intel && flow.intel.host;
    const ip = flow.ip || flow.intel && flow.intel.ip;
 
    const jobj = JSON.stringify({
      begin: flow.ts,
      dur: flow.du,
      intf: flow.intf,
      mac: flow.mac,
      destination: host || ip,
      sourceIp: flow.sh,
      destinationIp: flow.dh,
      sourcePort: _.isArray(flow.sp) ? flow.sp[0] : flow.sp,
      destinationPort: flow.dp,
      protocol: flow.pr || "",
      category: _.get(flow, ["intel", "category"]) || "",
      upload: flow.ob,
      download: flow.rb,
      app: app
    });

    await rclient.zaddAsync(key, flow.ts, jobj);
  }

  _isMatchPortInfo(portInfo, port, proto) {
    // if portInfo is empty, it means no port restriction
    if (!portInfo || _.isEmpty(portInfo)) return true;

    return _.some(portInfo, (pinfo) => {
      const startPort = parseInt(pinfo.start);
      const endPort = parseInt(pinfo.end);
      if (isNaN(startPort) || isNaN(endPort) || startPort < 0 || endPort < 0 || startPort > endPort)
        return false;
      return (!pinfo.proto || pinfo.proto === proto) && port >= startPort && port <= endPort;
    });
  }


  // returns an array with matched app criterias
  // [{"app": "youtube", "occupyMins": 1, "lingerMins": 1, "bytesThreshold": 1000000}]
  lookupAppMatch(flow) {
    const host = flow.host || flow.intel && flow.intel.host;
    const ip = flow.ip || (flow.intel && flow.intel.ip);
    const sigs = flow.sigs || [];
    const result = [];
    let internet_options = {
      app: "internet",
      occupyMins: 1,
      lingerMins: 10,
      minsThreshold: 1,
      noStray: true
    };

    if ((!this._domainTrie && !this._cidr4Trie && !this._cidr6Trie && !this._sigMap) || (!host && !ip))
      return result;
    // check domain trie
    const values = this._domainTrie.find(host);
    let isAppMatch = false;
    if (_.isSet(values)) {
      for (const value of values) {
        if (_.isObject(value) && value.app && !values.has(`!${value.app}`)) {
          if (!this._isMatchPortInfo(value.portInfo, flow.dp, flow.pr))
            continue;
          isAppMatch = true;
          if ((!value.bytesThreshold || flow.ob + flow.rb >= value.bytesThreshold)
            && (!value.ulDlRatioThreshold || flow.ob <= value.ulDlRatioThreshold * flow.rb)) {
            result.push(value);
            // keep internet options same as the matched app
            Object.assign(internet_options, {
              occupyMins: value.occupyMins,
              lingerMins: value.lingerMins,
              minsThreshold: value.minsThreshold,
              noStray: value.noStray
            });
            break;
          }
        }
      }
    }

    // check cidr trie
    let cidrTrie = new Address4(ip).isValid() ? this._cidr4Trie : this._cidr6Trie;
    if (_.isEmpty(result) && cidrTrie){
      const entry = cidrTrie.find(ip);
      if (_.isObject(entry)) {
        if (this._isMatchPortInfo(entry.portInfo, flow.dp, flow.pr)) {
          isAppMatch = true;
          if ((!entry.bytesThreshold || flow.ob + flow.rb >= entry.bytesThreshold)
            && (!entry.ulDlRatioThreshold || flow.ob <= entry.ulDlRatioThreshold * flow.rb))
            result.push(entry);
        }

      }
    }

    // check sigs
    if (_.isEmpty(result) && this._sigMap.size > 0) {
      for (const sigId of sigs) {
        const entry = this._sigMap.get(sigId);
        if (_.isObject(entry)) {
          isAppMatch = true;
          if ((!entry.bytesThreshold || flow.ob + flow.rb >= entry.bytesThreshold)
            && (!entry.ulDlRatioThreshold || flow.ob <= entry.ulDlRatioThreshold * flow.rb))
            result.push(entry);
        }
      }
    }

    if (isAppMatch && _.isEmpty(result)) {
      return result;
    }
    // match internet activity on flow
    const category = _.get(flow, ["intel", "category"]);
    const bytesThreshold = this.getCategoryBytesThreshold(category);
    // ignore flows with large upload/download ratio, e.g., a flow with large ul/dl ratio may happen if device is backing up data
    const ulDlRatioThreshold = this.getCategoryUlDlRatioThreshold(category);
    const nds = sl.getSensor("NoiseDomainsSensor");
    let flowNoiseTags = nds ? nds.find(host) : null;
    if ((flow.ob + flow.rb >= bytesThreshold && flow.ob <= ulDlRatioThreshold * flow.rb && _.isEmpty(flowNoiseTags)) || !_.isEmpty(result)) {
      log.debug("match internet activity on flow", flow, `bytesThresold: ${bytesThreshold}`);
      result.push(internet_options);
    }
    return result;
  }

  async processEnrichedFlow(f) {
    if (!this.enabled)
      return;
    const host = f.host || f.intel && f.intel.host;
    if (f.du > 300) {
      // long connection should be sliced into partial flows in zeek and BroDetect, in normal cases, duration should be no more than 3 minutes,
      //  a flow with long duration may happen if firemain is restarted
      log.warn("Unexpected flow with long duration, ignore", f.ts, f.du, f.sh, f.sp, '->', f.dh, f.dp);
      return;
    }
    if (fc.isFeatureOn("record_activity_flow")){
      this.recordFlow(f);
    }

    const appMatches = this.lookupAppMatch(f);
    if (_.isEmpty(appMatches))
      return;
    for (const match of appMatches) {
      const {app, category, domain, occupyMins, lingerMins, minsThreshold, noStray} = match;
      await this.recordFlow2Redis(f, app);
      if (host && domain)
        await dnsTool.addSubDomains(domain, [host]);
      let tags = []
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        tags.push(...(f[config.flowKey] || []));
      }
      tags = _.uniq(tags);
      await this.markBuckets(f.mac, tags, f.intf, app, category, f.ts, f.ts + f.du, occupyMins, lingerMins, minsThreshold, noStray);
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

  async markBuckets(mac, tags, intf, app, category, begin, end, occupyMins, lingerMins, minsThreshold, noStray = false) {
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

      const effective = (endMin - beginMin + 1 >= minsThreshold && !noStray) || extended; // do not record interval less than minsThreshold unless it is adjacent to linger minutes of other intervals
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
      if (effective) {
        const displayName = _.get(this.appConfs, [app, "displayName"]);
        if (displayName) {
          const recentActivity = {
            ts: begin,
            app: displayName
          };
          await hostTool.updateRecentActivity(mac, recentActivity);
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
