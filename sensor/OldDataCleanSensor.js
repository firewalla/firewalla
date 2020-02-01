/*    Copyright 2016 Firewalla LLC
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

const Policy = require('../alarm/Policy.js')
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

function arrayDiff(a, b) {
  return a.filter(function(i) {return b.indexOf(i) < 0;});
}

class OldDataCleanSensor extends Sensor {
  constructor() {
    super();
  }

  getExpiredDate(type) {
    let expireInterval = (this.config[type] && this.config[type].expires) || 0;
    if(expireInterval < 0) {
      return null;
    }

    let minInterval = 30 * 60;
    expireInterval = Math.max(expireInterval, minInterval);

    return Date.now() / 1000 - expireInterval;
  }

  getCount(type) {
    let count = (this.config[type] && this.config[type].count) || 10000;
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
  }

  async cleanToCount(key, leftOverCount) {
    const count = await rclient.zremrangebyrankAsync(key, 0, -1 * leftOverCount)
    if(count > 10) {
      log.info(util.format("%d entries in %s are cleaned by count", count, key));
    }
  }

  getKeys(keyPattern) {
    return rclient.keysAsync(keyPattern);
  }

  // clean by expired time and count
  async regularClean(type, keyPattern, ignorePatterns) {
    let keys = await this.getKeys(keyPattern);

    if (ignorePatterns) {
      keys = keys.filter((x) => {
        return ignorePatterns.filter((p) => x.match(p)).length === 0
      });
    }

    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const expireDate = this.getExpiredDate(type);
      if (expireDate !== null) {
        await this.cleanByExpireDate(key, expireDate);
      }
      const count = this.getCount(type);
      await this.cleanToCount(key, count);
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
    const keys = await rclient.keysAsync("flowgraph:*");
    for(const key of keys) {
      const ttl = await rclient.ttlAsync(key);
      if(ttl === -1) {
        await rclient.delAsync(key);
      }
    }
  }

  async cleanFlowGraphWhenInitializng() {
    return exec("redis-cli keys 'flowgraph:*' | xargs -n 100 redis-cli del");
  }

  async cleanHourlyStats() {
    // FIXME: not well coded here, deprecated code
    let keys = await rclient.keysAsync("stats:hour:*");
    const expireDate = Date.now() / 1000 - 60 * 60 * 24 * 2;
    for (const key of keys) {
      const timestamps = await rclient.zrangeAsync(key, 0, -1);
      const expiredTimestamps = timestamps.filter((timestamp) => {
        return Number(timestamp) < expireDate;
      });
      if(expiredTimestamps.length > 0) {
        await rclient.zremAsync([key, ...expiredTimestamps]);
      }
    }

    // expire legacy stats:last24 keys if its expiration is not set
    keys = await rclient.keysAsync("stats:last24:*");
    for (let j in keys) {
      const key = keys[j];
      const ttl = await rclient.ttlAsync(key);
      if (ttl === -1) {
        // legacy last 24 hour stats record, need to expire it.
        await rclient.expireAsync(key, 3600 * 24);
      }
    }
  }

  async cleanUserAgents() {
    // FIXME: not well coded here, deprecated code
    let MAX_AGENT_STORED = 150;
    let keys = await rclient.keysAsync("host:user_agent:*");
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
    const flows = await rclient.keysAsync("flow:x509:*");
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
            await rclient.delAsync(key);
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
      let aliveAlarms = await rclient.keysAsync("_alarm:*");
      let aliveIdSet = new Set(aliveAlarms.map(key => key.substring(7))); // remove "_alarm:" prefix

      let activeToRemove = activeIndex.filter(i => !aliveIdSet.has(i));
      if (activeToRemove.length) await rclient.zrem(activeKey, activeToRemove);
      let archiveToRemove = archiveIndex.filter(i => !aliveIdSet.has(i));
      if (archiveToRemove.length) await rclient.zrem(archiveKey, archiveToRemove);
    }
    catch(err) {
      log.error("Error cleaning alarm indexes", err);
    }
  }

  async cleanBrokenPolicies() {
    try {
      let keys = await rclient.keysAsync("policy:[0-9]*");
      for (const key of keys) {
        let policy = await rclient.hgetallAsync(key);
        let policyKeys = Object.keys(policy);
        if (policyKeys.length == 1 && policyKeys[0] == 'pid') {
          await rclient.zremAsync("policy_active", policy.pid);
          await rclient.delAsync(key);
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
  //   const keys = await rclient.keysAsync(keyPattern);
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

  async scheduledJob() {
    try {
      log.info("Start cleaning old data in redis")

      await this.regularClean("conn", "flow:conn:*");
      await this.regularClean("ssl", "flow:ssl:*");
      await this.regularClean("http", "flow:http:*");
      await this.regularClean("notice", "notice:*");
      await this.regularClean("intel", "intel:*", [/^intel:ip/, /^intel:url/]);
      await this.regularClean("software", "software:*");
      await this.regularClean("monitor", "monitor:flow:*");
      await this.regularClean("alarm", "alarm:ip4:*");
//    await this.regularClean("sumflow", "sumflow:*");
      await this.regularClean("syssumflow", "syssumflow:*");
      await this.regularClean("categoryflow", "categoryflow:*");
      await this.regularClean("appflow", "appflow:*");
      await this.regularClean("safe_urls", CommonKeys.intel.safe_urls);
      await this.regularClean("dns", "rdns:ip:*");
      await this.regularClean("perf", "perf:*");
      await this.regularClean("networkConfigHistory", "history:networkConfig:*")
      await this.cleanHourlyStats();
      await this.cleanUserAgents();
      await this.cleanHostData("host:ip4", "host:ip4:*", 60*60*24*30);
      await this.cleanHostData("host:ip6", "host:ip6:*", 60*60*24*30);
      await this.cleanHostData("host:mac", "host:mac:*", 60*60*24*365);
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
    }
  }

  listen() {
    sclient.on("message", (channel, message) => {
      if(channel === "OldDataCleanSensor" && message === "Start") {
        this.scheduledJob();
      }
    });
    sclient.subscribe("OldDataCleanSensor");
    log.info("Listen on channel FlowDataCleanSensor");
  }


  // could be disabled in the future when all policy blockin rule is migrated to general policy rules
  async hostPolicyMigration() {
    try {
      const keys = await rclient.keysAsync("policy:mac:*");
      for (let key of keys) {
        const blockin = await rclient.hgetAsync(key, "blockin");
        if (blockin && blockin == "true") {
          const mac = key.replace("policy:mac:", "")
          const rule = await pm2.findPolicy(mac, "mac");
          if (!rule) {
            log.info(`Migrating blockin policy for host ${mac} to policyRule`)
            const hostInfo = await hostTool.getMACEntry(mac);
            const newRule = new Policy({
              target: mac,
              type: "mac",
              target_name: hostInfo.name || hostInfo.bname || hostInfo.ipv4Addr,
              target_ip: hostInfo.ipv4Addr // target_name and target ip are necessary for old app display
            })
            const result = await pm2.checkAndSaveAsync(newRule);
            if (result) {
              await rclient.hsetAsync(key, "blockin", false);
              log.info("Migrated successfully")
            } else {
              log.error("Failed to migrate")
            }
          }
        }
      }
    } catch (err) {
      log.error("Failed to migrate host policy rules:", err);
    }
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

  run() {
    super.run();

    this.listen();

    this.hostPolicyMigration()

    this.legacySchedulerMigration();

    setTimeout(() => {
      this.scheduledJob();
      this.oneTimeJob()
      setInterval(() => {
        this.scheduledJob();
      }, 1000 * 60 * 60); // cleanup every hour
    }, 1000 * 60 * 5); // first time in 5 mins
  }
}

module.exports = OldDataCleanSensor;
