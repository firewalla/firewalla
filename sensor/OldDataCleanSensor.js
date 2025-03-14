/*    Copyright 2016-2025 Firewalla Inc.
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

const _ = require('lodash');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const migrationPrefix = "oldDataMigration";

const CommonKeys = require('../net2/CommonKeys.js');

const exec = require('child-process-promise').exec;

const platform = require('../platform/PlatformLoader.js').getPlatform();

const { REDIS_KEY_REDIS_KEY_COUNT, REDIS_KEY_CPU_USAGE } = require('../net2/Constants.js')
const fsp = require('fs').promises;
const f = require('../net2/Firewalla.js');
const sysManager = require('../net2/SysManager.js');
const Policy = require('../alarm/Policy.js');

function arrayDiff(a, b) {
  return a.filter(function(i) {return b.indexOf(i) < 0;});
}

class OldDataCleanSensor extends Sensor {
  getExpiredDate(type) {
    let platformRetentionTimeMultiplier = 1;
    switch (type) {
      case "conn":
      case "flowDNS":
      case "flowLocal":
      case "auditDrop":
      case "auditLocalDrop":
      case "categoryflow":
      case "appflow":
        platformRetentionTimeMultiplier = platform.getRetentionTimeMultiplier();
        break;
      case "auditAccept":
        platformRetentionTimeMultiplier = platform.getDNSFlowRetentionTimeMultiplier();
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
      case "flowDNS":
      case "flowLocal":
      case "auditDrop":
      case "auditLocalDrop":
      case "categoryflow":
      case "appflow":
        platformRetentionCountMultiplier = platform.getRetentionCountMultiplier();
        break;
      case "auditAccept":
        platformRetentionCountMultiplier = platform.getDNSFlowRetentionCountMultiplier();
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
      log.verbose(util.format("%d entries in %s are cleaned by expired date", count, key));
    }
    await rclient.persistAsync(key)
    return count;
  }

  async cleanToCount(key, leftOverCount) {
    const count = await rclient.zremrangebyrankAsync(key, 0, -1 * leftOverCount)
    if(count > 10) {
      log.info(util.format("%d entries in %s are cleaned by count", count, key));
    }
    return count;
  }

  async regularClean(fullClean = false) {
    let wanAuditDropCleaned = false;
    let batch = []
    await rclient.scanAll(null, async (keys) => {
      for (const key of keys) {
        for (const {type, filterFunc, count, expireInterval, fullCleanOnly, customCleanerFunc} of this.filterFunctions) {
          if (fullCleanOnly && !fullClean)
            continue;
          if (filterFunc(key)) {
            if (customCleanerFunc) {
              try {
                await customCleanerFunc(type, key, batch)
              } catch(err) {
                log.error('Error executing customized clean', type, key, err)
              }
            } else if (type === "auditDrop" && key.startsWith(`audit:drop:${Constants.NS_INTERFACE}:`)) {
              let cntE = 0;
              let cntC = 0;
              if (expireInterval)
                cntE = await this.cleanByExpireDate(key, Date.now() / 1000 - expireInterval);
              if (count)
                cntC = await this.cleanToCount(key, count);
              if (cntE + cntC > 0)
                wanAuditDropCleaned = true;
            } else {
              if (expireInterval) {
                batch.push(['zremrangebyscore', key, "-inf", Date.now() / 1000 - expireInterval]);
                // remove expire on those keys as they are now managed by OldDataCleanSensor
                batch.push(['persist', key]);
              }
              if (count) {
                batch.push(['zremrangebyrank', key, 0, -count])
              }
            }
          }
        }

        if (batch.length > 200) {
          await rclient.pipelineAndLog(batch)
          batch = []
        }
      }
    });
    if (batch.length)
      await rclient.pipelineAndLog(batch)
    if (wanAuditDropCleaned) {
      sem.emitLocalEvent({
        type: "AuditFlowsDrop",
        suppressEventLogging: false
      });
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

  async cleanFlowGraph(type, key, batch) {
    const ttl = await rclient.ttlAsync(key);
    if(ttl === -1) {
      batch.push(['unlink', key]);
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

  async cleanFlowX509(type, key, batch) {
    const ttl = await rclient.ttlAsync(key);
    if(ttl === -1) {
      batch.push(['expire', key, this.config[type].expires || 600]);
    }
  }

  async cleanHostData(type, key, batch) {
    const expireInterval = this.config[type] && this.config[type].expires
    const expireTS = Date.now() / 1000 - expireInterval;
    const results = await rclient.hmgetAsync(key, 'lastActiveTimestamp', 'firstFoundTimestamp')
    if (!results) return
    const activeTS = results[0] || results[1]
    if (!activeTS) return
    if (activeTS < expireTS) {
      log.info(key, "Deleting due to timeout", activeTS);
      batch.push(['unlink', key])
      if (type == 'host:mac')
        batch.push(['zrem', Constants.REDIS_KEY_HOST_ACTIVE, key.substring(9)])
    } else {
      if (type == 'host:mac')
        batch.push(['zadd', Constants.REDIS_KEY_HOST_ACTIVE, activeTS, key.substring(9)])
    }
  }

  async cleanDuplicatedPolicy() {
    const policies = await pm2.loadActivePoliciesAsync();

    let toBeDeleted = []

    for (let i = 0; i < policies.length; i++) {
      let p = policies[i]
      for (let j = i + 1; j < policies.length; j++) {
        let p2 = policies[j]
        if (p && p.isEqual(p2)) {
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
      const batch = []

      // exists returns a numbers of all existing with provided list, so this has to be done separately
      const activeData = await rclient.pipelineAndLog(activeIndex.map(id => ['exists', '_alarm:'+id]))
      for (let i in activeIndex) {
        if (!activeData[i]) batch.push(['zrem', activeKey, activeIndex[i]])
      }
      const archiveData = await rclient.pipelineAndLog(archiveIndex.map(id => ['exists', '_alarm:'+id]))
      for (let i in archiveIndex) {
        if (!archiveData[i]) batch.push(['zrem', archiveKey, archiveIndex[i]])
      }
      await rclient.pipelineAndLog(batch)
    } catch(err) {
      log.error("Error cleaning alarm indexes", err);
    }
  }

  async cleanBrokenPolicy(type, key, batch) {
    let policy = await rclient.hgetallAsync(key);
    let policyKeys = Object.keys(policy);
    if (policyKeys.length == 1 && policyKeys[0] == 'pid') {
      batch.push(
        ['zrem', "policy_active", policy.pid],
        ['unlink', key],
      )
      log.info("Remove broken policy:", policy.pid);
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

  async countIntelData() {
    const counts = { }
    const prefixes = [ 'intel:ip:', 'intel:url:', 'inteldns:' ]
    for (const prefix of prefixes) {
      counts[prefix] = 0
    }
    await rclient.scanAll(null, results => {
      results.forEach(key => {
        for (const prefix of prefixes) {
          if (key.startsWith(prefix)) counts[prefix] ++
        }
      })
    })

    await rclient.hmsetAsync(REDIS_KEY_REDIS_KEY_COUNT, counts)
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

      await this.regularClean(fullClean);

      await this.cleanUserAgents();
      await this.cleanupAlarmExtendedKeys();
      await this.cleanAlarmIndex();
      await this.cleanExceptions();
      await this.cleanSecurityIntelTracking();

      await this.countIntelData()

      if (fullClean)
        await this.cleanupLegacyNetworkUUIDs();

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
    const patterns = [/^flow:tag:.*:recent$/, /^flow:intf:.*:recent$/, /^stats:hour:/]

    const batch = [ ['unlink', 'flow:global:recent'] ]
    await rclient.scanAll(null, async (keys) => {
      for (const key of keys) {
        if (patterns.some(p => key.match(p)))
          batch.push(['unlink', key])
      }
    })
    await rclient.pipelineAndLog(batch)
  }

  async cleanupRedisSetCache(key, maxCount) {
    const curSize = rclient.scardAsync(key);
    if(curSize && curSize > maxCount) {
      await rclient.unlinkAsync(key); // since it's a cache key, safe to delete it
    }
  }

  async cleanupLegacyNetworkUUIDs() {
    const networkConfigs = (await rclient.zrangeAsync("history:networkConfig", 0, -1) || []).map(data => {
      try {
        const json = JSON.parse(data);
        return json;
      } catch (err) {
        return null;
      }
    }).filter(o => _.isObject(o));

    const uuids = new Set();
    for (const networkConfig of networkConfigs) {
      const intfConfig = _.get(networkConfig, "interface", {});      
      for (const typeKey of Object.keys(intfConfig)) {
        const intfs = intfConfig[typeKey];
        for (const name of Object.keys(intfs)) {
          const uuid = _.get(intfs, [name, "meta", "uuid"]);
          if (uuid)
            uuids.add(uuid);
        }
      }
    }
    const currentIntfs = sysManager.getLogicInterfaces() || [];
    for (const intf of currentIntfs) {
      if (intf.uuid)
        uuids.add(intf.uuid);
    }

    // remove rules that use a legacy network uuid
    const rules = await pm2.loadActivePoliciesAsync({includingDisabled: true});
    for (const rule of rules) {
      if (rule.pid && _.isArray(rule.tag) && rule.tag.every(s => s.startsWith(Policy.INTF_PREFIX) && !uuids.has(s.substring(Policy.INTF_PREFIX.length)))) {
        log.info(`Rule ${rule.pid} is applied to a legacy network, will be deleted`, rule);
        await pm2.disableAndDeletePolicy(rule.pid).catch((err) => {});
      }
    }

    // remove leftover network uuid directory that are no longer used in historical network config data from dnsmasq config directory
    const files = await fsp.readdir(`${f.getUserConfigFolder()}/dnsmasq`, {withFileTypes: true}).catch((err) => {
      log.error("Failed to readdir on dnsmasq config folder", err.message);
      return [];
    });

    for (const file of files) {
      if (file.isDirectory() && file.name) {
        let shouldRemove = false;
        // VPN client config directory
        if (file.name.startsWith("VC:") || file.name.startsWith("VWG:")) {
          // TODO
        } else {
          if (file.name.startsWith("WAN:") && file.name.length === 45 && (file.name.endsWith("_hard") || file.name.endsWith("_soft"))) {
            // WAN PBR config directory
            if (!uuids.has(file.name.substring(4, 40)))
              shouldRemove = true;
          } else {
            // network uuid config directory
            if (file.name.length === 36 && !uuids.has(file.name))
              shouldRemove = true;
          }
        }
        if (shouldRemove) {
          log.info(`Directory ${file.name} under ${f.getUserConfigFolder()}/dnsmasq is no longer used in any historical network config, delete it`);
          await exec(`rm -rf ${f.getUserConfigFolder()}/dnsmasq/${file.name}`).catch((err) => {});
        }
      }
    }
  }

  registerFilterFunctions() {
    // need to take into consideration the time complexity of the filter function, it will be applied on all keys
    this._registerFilterFunction("conn", (key) => key.startsWith("flow:conn:"));
    this._registerFilterFunction("flowDNS", (key) => key.startsWith("flow:dns:"));
    this._registerFilterFunction("flowLocal", (key) => key.startsWith("flow:local:"));
    this._registerFilterFunction("auditDrop", (key) => key.startsWith("audit:drop:"));
    this._registerFilterFunction("auditAccept", (key) => key.startsWith("audit:accept:"));
    this._registerFilterFunction("auditLocalDrop", (key) => key.startsWith("audit:local:drop"));
    this._registerFilterFunction("http", (key) => key.startsWith("flow:http:"));
    this._registerFilterFunction("x509", key => key.startsWith("flow:x509:"), false, this.cleanFlowX509.bind(this));
    this._registerFilterFunction("flowgraph", key => key.startsWith("flowgraph:"), false, this.cleanFlowGraph);
    this._registerFilterFunction("notice", (key) => key.startsWith("notice:"));
    this._registerFilterFunction("monitor", (key) => key.startsWith("monitor:flow:"));
    this._registerFilterFunction("categoryflow", (key) => key.startsWith("categoryflow:"));
    this._registerFilterFunction("appflow", (key) => key.startsWith("appflow:"));
    this._registerFilterFunction("safe_urls", (key) => key === CommonKeys.intel.safe_urls);
    // the total number of these two entries are proportional to traffic volume, instead of number of devices
    // regularClean may take much more time to scan all matched keys, so only do it in full clean
    this._registerFilterFunction("dns", (key) => key.startsWith("rdns:ip:"), true);
    this._registerFilterFunction("dns", (key) => key.startsWith("rdns:domain:"), true);
    this._registerFilterFunction("perf", (key) => key.startsWith("perf:"));
    this._registerFilterFunction("dns_proxy", (key) => key.startsWith("dns_proxy:"));
    this._registerFilterFunction("action_history", (key) => key === "action:history");
    this._registerFilterFunction("networkConfigHistory", (key) => key === "history:networkConfig");
    this._registerFilterFunction("internetSpeedtest", (key) => key === "internet_speedtest_results");
    this._registerFilterFunction("dhclientRecord", (key) => key.startsWith("dhclient_record:"));
    this._registerFilterFunction("cpu_usage", (key) => key === REDIS_KEY_CPU_USAGE);
    this._registerFilterFunction("device_flow_ts", (key) => key === "deviceLastFlowTs");
    this._registerFilterFunction("user_agent2", key => key.startsWith('host:user_agent2:'))
    this._registerFilterFunction("dm", (key) => key.startsWith("dm:host:"), true);
    this._registerFilterFunction("host:ip4", key => key.startsWith('host:ip4:'), false, this.cleanHostData.bind(this))
    this._registerFilterFunction("host:ip6", key => key.startsWith('host:ip6:'), false, this.cleanHostData.bind(this))
    this._registerFilterFunction("host:mac", key => key.startsWith('host:mac:'), false, this.cleanHostData.bind(this))
    this._registerFilterFunction("digitalfence", key => key.startsWith('digitalfence:'), false, this.cleanHostData.bind(this))
    this._registerFilterFunction("policy", key => key.match(/^policy:[0-9]+/), false, this.cleanBrokenPolicy.bind(this))
  }

  _registerFilterFunction(type, filterFunc, fullCleanOnly = false, customCleanerFunc) {
    let platformRetentionCountMultiplier = 1;
    let platformRetentionTimeMultiplier = 1;
    switch (type) {
      case "conn":
      case "flowDNS":
      case "flowLocal":
      case "auditDrop":
      case "auditAccept":
      case "auditLocalDrop":
      case "categoryflow":
      case "appflow":
        platformRetentionCountMultiplier = platform.getRetentionCountMultiplier();
        platformRetentionTimeMultiplier = platform.getRetentionTimeMultiplier();
        break;
    }
    let count = (this.config[type] && this.config[type].count * platformRetentionCountMultiplier) || 10000;
    let expireInterval = (this.config[type] && this.config[type].expires * platformRetentionTimeMultiplier) || 0;
    if (count < 0)
      count = null;
    if (expireInterval < 0)
      expireInterval = null;
    this.filterFunctions.push({type, filterFunc, count, expireInterval, fullCleanOnly, customCleanerFunc});
  }

  run() {
    super.run();

    try {
      this.listen();

      this.legacySchedulerMigration();

      this.deleteObsoletedData();

      this.filterFunctions = [];
      this.registerFilterFunctions();
    } catch(err) {
      log.error('Failed to run one time jobs', err);
    }

    setTimeout(() => {
      this.scheduledJob();
      this.oneTimeJob();
      setInterval(() => {
        this.scheduledJob();
      }, 1000 * 60 * 45); // cleanup every 45 minutes
    }, 1000 * 60 * 5); // first time in 5 mins
  }
}

module.exports = OldDataCleanSensor;
