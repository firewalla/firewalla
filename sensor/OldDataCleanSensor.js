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

let util = require('util');

let Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const sem = require('./SensorEventManager.js').getInstance();
const Constants = require('../net2/Constants.js');
const PolicyManager2 = require('../alarm/PolicyManager2.js')
const pm2 = new PolicyManager2()

const ExceptionManager = require('../alarm/ExceptionManager.js')
const em = new ExceptionManager()

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const am2 = new AlarmManager2();

const Promise = require('bluebird');

const _ = require('lodash');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const migrationPrefix = "oldDataMigration";

const CommonKeys = require('../net2/CommonKeys.js');

const exec = require('child-process-promise').exec;

const platform = require('../platform/PlatformLoader.js').getPlatform();

function arrayDiff(a, b) {
  return a.filter(function(i) {return b.indexOf(i) < 0;});
}

class OldDataCleanSensor extends Sensor {
  getExpiredDate(type) {
    let platformRetentionTimeMultiplier = 1;
    switch (type) {
      case "conn":
      case "audit":
      case "categoryflow":
      case "appflow":
        platformRetentionTimeMultiplier = platform.getRetentionTimeMultiplier();
        break;
    }
    let expireInterval = (this.config[type] && this.config[type].expires * platformRetentionTimeMultiplier) || 0;
    if(expireInterval < 0) {
      return null;
    }

    let minInterval = 30 * 60;
    expireInterval = Math.max(expireInterval, minInterval);

    return Date.now() / 1000 - expireInterval;
  }

  getCount(type) {
    let platformRetentionCountMultiplier = 1;
    switch (type) {
      case "conn":
      case "categoryflow":
      case "appflow":
        platformRetentionCountMultiplier = platform.getRetentionCountMultiplier();
        break;
    }
    let count = (this.config[type] && this.config[type].count * platformRetentionCountMultiplier) || 10000;
    if(count < 0) {
      return null;
    }
    return count;
  }

  async cleanByExpireDate(key, expireDate) {
    const count = await rclient.zremrangebyscoreAsync(key, "-inf", expireDate);
    if(count > 10) {
      log.info(util.format("%d entries in %s are cleaned by expired date", count, key));
    }
    return count;
  }

  async cleanToCount(key, leftOverCount) {
    const count = await rclient.zremrangebyrankAsync(key, 0, -1 * leftOverCount)
    if(count > 10) {
      log.info(util.format("%d entries in %s are cleaned by count", count, key));
    }
    return count;
  }

  getKeys(keyPattern) {
    return rclient.scanResults(keyPattern);
  }

  // clean by expired time and count
  async regularClean(type, keyPattern, ignorePatterns) {
    let keys = keyPattern.includes('*')
      ? await this.getKeys(keyPattern)
      : [ keyPattern ]

    if (ignorePatterns) {
      keys = keys.filter(x => !ignorePatterns.some(p => x.match(p)))
    }
    let cleanCount = 0;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const expireDate = this.getExpiredDate(type);
      let cntE, cntC = 0;
      if (expireDate !== null) {
        cntE = await this.cleanByExpireDate(key, expireDate);
      }
      const count = this.getCount(type);
      cntC = await this.cleanToCount(key, count);
      if (key.includes(`:${Constants.NS_INTERFACE}:`)) {
        cleanCount = cleanCount + cntE + cntC;
      }
    }
    if (type == "auditDrop" && cleanCount > 0) {
      sem.emitLocalEvent({
        type: "AuditFlowsDrop",
        suppressEventLogging: false
      })
    }
  }

  async cleanExceptions() {
    const queueKey = "exception_queue";

    try {
      // remove non-existing exception from queue
      let exQueue = await rclient.smembersAsync(queueKey)
      let invalidQueue = []

      for (let id of exQueue) {
        let exist = await em.exceptionExists(id);
        if (!exist) invalidQueue.push(id)
      }

      if(!_.isEmpty(invalidQueue)) {
        await rclient.sremAsync(queueKey, invalidQueue);
      }
    }
    catch(err) {
      log.error("Error cleaning exceptions", err);
    }
  }

  cleanSumFlow() {

  }

  cleanHourlyFlow() {

  }

  async cleanFlowGraph() {
    const keys = await rclient.scanResults("flowgraph:*");
    for(const key of keys) {
      const ttl = await rclient.ttlAsync(key);
      if(ttl === -1) {
        await rclient.unlinkAsync(key);
      }
    }
  }

  async cleanFlowGraphWhenInitializng() {
    return exec("redis-cli keys 'flowgraph:*' | xargs -n 100 redis-cli unlink");
  }

  async cleanUserAgents() {
    // FIXME: not well coded here, deprecated code
    let MAX_AGENT_STORED = 150;
    let keys = await rclient.scanResults("host:user_agent:*");
    for (let j in keys) {
      let count = await rclient.scardAsync(keys[j]);
      if (count > MAX_AGENT_STORED) {
        log.info(keys[j], " pop count ", count - MAX_AGENT_STORED);
        for (let i = 0; i < count - MAX_AGENT_STORED; i++) {
          try {
            await rclient.spopAsync(keys[j]);
          } catch(err) {
            log.info(keys[j], " count ", count - MAX_AGENT_STORED, err);
          }
        }
      }
    }
  }

  async cleanFlowX509() {
    const flows = await rclient.scanResults("flow:x509:*");
    for(const flow of flows) {
      const ttl = await rclient.ttlAsync(flow);
      if(ttl === -1) {
        await rclient.expireAsync(flow, 600); // 600 is default expire time if expire is not set
      }
    }
  }

  async cleanHostData(type, keyPattern, defaultExpireInterval) {
    let expireInterval = (this.config[type] && this.config[type].expires) ||
      defaultExpireInterval;

    let expireDate = Date.now() / 1000 - expireInterval;

    let keys = await this.getKeys(keyPattern)

    return Promise.all(
      keys.map(async (key) => {
        let data = await rclient.hgetallAsync(key)
        if (data && data.lastActiveTimestamp) {
          if (data.lastActiveTimestamp < expireDate) {
            log.info(key, "Deleting due to timeout ", expireDate, data);
            await rclient.unlinkAsync(key);
          }
        }
      })
    ).then(() => {
      // log.info("CleanHostData on", keys, "is completed");
    })
  }

  async cleanDuplicatedPolicy() {
    const policies = await pm2.loadActivePoliciesAsync();

    let toBeDeleted = []

    for (let i = 0; i < policies.length; i++) {
      let p = policies[i]
      for (let j = i + 1; j < policies.length; j++) {
        let p2 = policies[j]
        if (p && p2 && p.isEqualToPolicy(p2)) {
          toBeDeleted.push(p)
          break
        }
      }
    }

    for (let k in toBeDeleted) {
      let p = toBeDeleted[k]
      await pm2.deletePolicy(p.pid);
    }
  }

  async cleanDuplicatedException() {
    let exceptions = [];
    try {
      exceptions = await em.loadExceptionsAsync();
    } catch (err) {
      log.error("Error when loadExceptions", err);
    }

    let toBeDeleted = []

    for (let i = 0; i < exceptions.length; i++) {
      let e = exceptions[i]
      for (let j = i + 1; j < exceptions.length; j++) {
        let e2 = exceptions[j]
        if (e && e2 && e.isEqualToException(e2)) {
          toBeDeleted.push(e)
          break
        }
      }
    }

    for (let k in toBeDeleted) {
      let e = toBeDeleted[k]
      try {
        await em.deleteException(e.eid);
      } catch (err) {
        log.error("Error when delete exception", err);
      }
    }
  }

  async cleanInvalidMACAddress() {
    const macs = await hostTool.getAllMACs();
    const invalidMACs = macs.filter((m) => {
      return m.match(/[a-f]+/) != null
    })
    return Promise.all(
      invalidMACs.map(m => hostTool.deleteMac(m))
    )
  }

  async cleanupAlarmExtendedKeys() {
    log.info("Cleaning up alarm extended keys");

    const basicAlarms = await am2.listBasicAlarms();
    const extendedAlarms = await am2.listExtendedAlarms();

    const diff = arrayDiff(extendedAlarms, basicAlarms);

    for (let index = 0; index < diff.length; index++) {
      const alarmID = diff[index];
      await am2.deleteExtendedAlarm(alarmID);
    }
  }

  async cleanAlarmIndex() {
    const activeKey = "alarm_active";
    const archiveKey = "alarm_archive";
    try {
      let activeIndex = await rclient.zrangebyscoreAsync(activeKey, '-inf', '+inf');
      let archiveIndex = await rclient.zrangebyscoreAsync(archiveKey, '-inf', '+inf');
      let aliveAlarms = await rclient.scanResults("_alarm:*");
      let aliveIdSet = new Set(aliveAlarms.map(key => key.substring(7))); // remove "_alarm:" prefix

      let activeToRemove = activeIndex.filter(i => !aliveIdSet.has(i));
      if (activeToRemove.length) await rclient.zremAsync(activeKey, activeToRemove);
      let archiveToRemove = archiveIndex.filter(i => !aliveIdSet.has(i));
      if (archiveToRemove.length) await rclient.zremAsync(archiveKey, archiveToRemove);
    }
    catch(err) {
      log.error("Error cleaning alarm indexes", err);
    }
  }

  async cleanBrokenPolicies() {
    try {
      let keys = await rclient.scanResults("policy:[0-9]*");
      for (const key of keys) {
        let policy = await rclient.hgetallAsync(key);
        let policyKeys = Object.keys(policy);
        if (policyKeys.length == 1 && policyKeys[0] == 'pid') {
          await rclient.zremAsync("policy_active", policy.pid);
          await rclient.unlinkAsync(key);
          log.info("Remove broken policy:", policy.pid);
        }
      }
    } catch(err) {
      log.error("Failed to clean broken policies", err);
    }
  }

  async cleanSecurityIntelTracking() {
    const key = intelTool.getSecurityIntelTrackingKey();
    const intelKeys = await rclient.zrangeAsync(key, 0, -1);

    for(const intelKey of intelKeys) {
      if(!intelKey.startsWith("intel:ip:")) {
        continue;
      }

      const exists = await rclient.existsAsync(intelKey);
      if(exists !== 1) { // not existing any more
        await rclient.zremAsync(key, intelKey);
      }
    }
  }

  // async cleanBlueRecords() {
  //   const keyPattern = "blue:history:domain:*"
  //   const keys = await rclient.scanResults(keyPattern);
  //   for (let i = 0; i < keys.length; i++) {
  //     const key = keys[i];
  //     await rclient.zremrangebyscoreAsync(key, '-inf', Math.floor(new Date() / 1000 - 3600 * 48)) // keep two days
  //   }
  // }

  async oneTimeJob() {
    await this.cleanDuplicatedPolicy();
    await this.cleanDuplicatedException();
    await this.cleanInvalidMACAddress();
    await this.cleanFlowGraphWhenInitializng();
  }

  async scheduledJob(fullClean = false) {
    if (fullClean ? this.fullCleanRunning : this.regularCleanRunning) {
      log.warn(`The previous ${fullClean ? "full clean" : "regular clean"} scheduled job is still running, skip this time`);
      return;
    }
    try {
      if (fullClean)
        this.fullCleanRunning = true;
      else
        this.regularCleanRunning = true;
      log.info(`Start ${fullClean ? "full" : "regular"} cleaning old data in redis`)

      await this.regularClean("conn", "flow:conn:*");
      await this.regularClean("auditDrop", "audit:drop:*");
      await this.regularClean("auditAccept", "audit:accept:*");
      await this.regularClean("http", "flow:http:*");
      await this.regularClean("notice", "notice:*");
      await this.regularClean("monitor", "monitor:flow:*");
      /* sumflows are already trimmed when they are generated
      await this.regularClean("sumflow", "sumflow:*");
      await this.regularClean("syssumflow", "syssumflow:*");
      */
      await this.regularClean("categoryflow", "categoryflow:*");
      await this.regularClean("appflow", "appflow:*");
      await this.regularClean("safe_urls", CommonKeys.intel.safe_urls);
      if (fullClean) {
        // the total number of these two entries are proportional to traffic volume, instead of number of devices
        // regularClean may take much more time to scan all matched keys, so do not do it too frequently
        await this.regularClean("dns", "rdns:ip:*"); // dns timeout config applies to both ip->domain and domain->ip mappings
        await this.regularClean("dns", "rdns:domain:*");
      }
      await this.regularClean("perf", "perf:*");
      await this.regularClean("dns_proxy", "dns_proxy:*");
      await this.regularClean("action_history", "action:history*");
      await this.regularClean("networkConfigHistory", "history:networkConfig*");
      await this.regularClean("internetSpeedtest", "internet_speedtest_results*");
      await this.regularClean("dhclientRecord", "dhclient_record:*");
      await this.regularClean("cpu_usage", "cpu_usage_records");
      await this.cleanUserAgents();
      await this.cleanHostData("host:ip4", "host:ip4:*", 60*60*24*30);
      await this.cleanHostData("host:ip6", "host:ip6:*", 60*60*24*30);
      await this.cleanHostData("host:mac", "host:mac:*", 60*60*24*365);
      await this.cleanHostData("digitalfence", "digitalfence:*", 3600);
      await this.cleanFlowX509();
      await this.cleanFlowGraph();
      await this.cleanupAlarmExtendedKeys();
      await this.cleanAlarmIndex();
      await this.cleanExceptions();
      await this.cleanSecurityIntelTracking();
      await this.cleanBrokenPolicies();

      // await this.cleanBlueRecords()
      log.info("scheduledJob is executed successfully");
    } catch(err) {
      log.error("Failed to run scheduled job, err:", err);
    } finally {
      if (fullClean)
        this.fullCleanRunning = false;
      else
        this.regularCleanRunning = false;
    }
  }

  listen() {
    // the message will be published in cronjob
    sclient.on("message", (channel, message) => {
      if(channel === "OldDataCleanSensor") {
        switch (message) {
          case "Start": {
            this.scheduledJob();
            break;
          }
          case "FullClean": {
            this.scheduledJob(true);
            break;
          }
          default:
        }
      }
    });
    sclient.subscribe("OldDataCleanSensor");
    log.info("Listen on channel FlowDataCleanSensor");
  }

  async legacySchedulerMigration() {
    const key = `${migrationPrefix}:legacySchedulerMigration`;
    const result = await rclient.typeAsync(key);
    if(result !== "none") {
      return;
    }

    const policyRules = await pm2.loadActivePoliciesAsync();
    for(const rule of policyRules) {
      if(rule.cronTime === "* * * * 1" && rule.duration === "432000") {
        rule.cronTime = "0 0 * * 1,2,3,4,5";
        rule.duration = "86390";
        await pm2.updatePolicyAsync(rule);
      } else if(rule.cronTime === "* * * * 6" && rule.duration === "172800") {
        rule.cronTime = "0 0 * * 0,6";
        rule.duration = "86390";
        await pm2.updatePolicyAsync(rule);
      }
    }

    await rclient.setAsync(key, "1");
    return;
  }

  async deleteObsoletedData() {
    await rclient.unlinkAsync('flow:global:recent');

    const patterns = ['flow:tag:*:recent', 'flow:intf:*:recent', 'stats:hour:*']
    for (const pattern of patterns) {
      const keys = await rclient.scanResults(pattern)
      if (keys.length)
        await rclient.unlinkAsync(keys)
    }
  }

  async cleanupRedisSetCache(key, maxCount) {
    const curSize = rclient.scardAsync(key);
    if(curSize && curSize > maxCount) {
      await rclient.unlinkAsync(key); // since it's a cache key, safe to delete it
    }
  }

  run() {
    super.run();

    try {
      this.listen();

      this.legacySchedulerMigration();

      this.deleteObsoletedData();
    } catch(err) {
      log.error('Failed to run one time jobs', err);
    }

    setTimeout(() => {
      this.scheduledJob();
      this.oneTimeJob();
      setInterval(() => {
        this.scheduledJob();
      }, 1000 * 60 * 60); // cleanup every hour
    }, 1000 * 60 * 5); // first time in 5 mins
  }
}

module.exports = OldDataCleanSensor;
