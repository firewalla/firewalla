/*    Copyright 2020-2025 Firewalla Inc.
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
const CronJob = require('cron').CronJob;
const cronParser = require('cron-parser');
const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const firewalla = require('../net2/Firewalla.js');
const fpath = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const util = require('util');
const bone = require("../lib/Bone.js");
const rclient = require('../util/redis_manager.js').getRedisClient();
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);
const scanConfigPath = `${firewalla.getHiddenFolder()}/run/scan_config`;
const f = require('../net2/Firewalla.js');
const Ranges = require('../util/Ranges.js');
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const IdentityManager = require('../net2/IdentityManager.js');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const tagManager = require('../net2/TagManager.js');
const xml2jsonBinary = firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + firewalla.getPlatform();
const httpBruteScript = firewalla.getHiddenFolder() + "/run/assets/http-brute.nse";
const mysqlBruteScript = firewalla.getHiddenFolder() + "/run/assets/mysql-brute.nse";
const libmysqlclientSO = firewalla.getHiddenFolder() + "/run/assets/libmysqlclient.so.21"
const _ = require('lodash');
const bruteConfig = require('../extension/nmap/bruteConfig.json');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_TASK_QUEUE = "LOCK_TASK_QUEUE";
const LOCK_APPLY_INTERNAL_SCAN_POLICY = "LOCK_APPLY_INTERNAL_SCAN_POLICY";
const MAX_CONCURRENT_TASKS = 3;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

const extensionManager = require('./ExtensionManager.js');
const sysManager = require('../net2/SysManager.js');
const Constants = require('../net2/Constants.js');
const {Address4, Address6} = require('ip-address');
const crypto = require('crypto');

const STATE_SCANNING = "scanning";
const STATE_COMPLETE = "complete";
const STATE_STOPPED = "stopped";
const STATE_QUEUED = "queued";

const featureName = 'weak_password_scan';
const policyKeyName = 'weak_password_scan';
const MIN_CRON_INTERVAL = 86400; // at most one job every 24 hours, to avoid job queue congestion
const TTL_SEC = 2678400; // expire in 86400 * 31 seconds

class InternalScanSensor extends Sensor {
  constructor(config) {
    super(config)
    this.featureOn = false;
    this.supportPorts = ["tcp_23", "tcp_80", "tcp_21", "tcp_3306", "tcp_6379"]; // default support: telnet http ftp mysql redis

    this.scheduledScanTasks = {};
    this.subTaskRunning = {};
    this.subTaskWaitingQueue = [];
    this.subTaskMap = {};

    this.scanJob = null;
    this.policy;

    if (platform.supportSSHInNmap()) {
      this.supportPorts.push("tcp_22");
    }

    if (f.isMain()) {
      sem.on("SubmitWeakPasswordScanTask", async(event) => {
        const {hosts, key} = event;
        await this.submitTask(key || ("" + Date.now() / 1000), hosts);
        this.scheduleTask();
        await this.saveScanTasks();
      });

      sem.on("StopWeakPasswordScanTask", async(event) => {
        log.info('receive stop scan event');
        const result = await this.getScanResult()
        log.debug("try to stop", JSON.stringify(result.tasks));
        if (!result || !result.tasks) {
          return;
        }
        for (const key in result.tasks) {
          if (result.tasks[key].state == STATE_SCANNING || result.tasks[key].state == STATE_QUEUED) {
            try {
              await this._stopScanTask(key, '0.0.0.0');
            } catch(err){
              log.warn('cannot stop scan task key', key, err.message);
              continue
            };
          }
        }
      })
    }
  }

  async globalOn() {
    log.info(`feature ${featureName} global on`);
    this.featureOn = true;
  }

  async globalOff() {
    log.info(`feature ${featureName} global off`);
    this.featureOn = false;
  }

  async loadPolicyAsync() {
    const data = await rclient.hgetAsync(hostManager._getPolicyKey(), policyKeyName);
    if (!data) {
      return;
    }
    try{
      return JSON.parse(data);
    } catch(err){
      log.warn(`fail to load policy, invalid json ${data}`);
    };
  }

  async run() {
    this.policy = await this.loadPolicyAsync();
    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy
    })
    this.hookFeature(featureName);
    const previousScanResult = await this.getScanResult();
    if (_.has(previousScanResult, "tasks"))
      this.scheduledScanTasks = previousScanResult.tasks || {};
    // set state of previous pending/running tasks to "stopped" on service restart
    for (const key of Object.keys(this.scheduledScanTasks)) {
      const task = this.scheduledScanTasks[key];
      if (task.state === STATE_QUEUED || task.state === STATE_SCANNING) {
        task.state = STATE_STOPPED;
        task.ets = Date.now() / 1000;
      }
    }
    await execAsync(`sudo cp ../extension/nmap/scripts/mysql.lua /usr/share/nmap/nselib/`).catch((err) => {});
    setInterval(() => {
      this._cleanTasks();
      this.checkRunningStatus();
    }, 60 * 1000);
  }

  async apiRun() {
    setInterval(() => {
      this.checkDictionary().catch((err) => {
        log.error(`Failed to fetch dictionary from cloud`, err.message);
      });
    }, 3600 * 1000 * 24);
    await this.checkDictionary().catch((err) => {
      log.error(`Failed to fetch dictionary from cloud`, err.message);
    });

    extensionManager.onCmd("scheduleWeakPasswordScanTask", async (msg, data) => {
      // check and update running status
      const result = await this._updateRunningStatus(STATE_SCANNING);
      log.info('scan task status update result', result);
      if (result != 1) {
        log.info('scan task is running, skip', result);
        return this.getScanResult(1);
      }
      const {type, target} = data;
      let key = null;
      let hosts = null;
      switch (type) {
        case "host": {
          key = target
          if (target === "0.0.0.0") {
            let scanPolicy = await this.loadPolicyAsync();
            if (!scanPolicy) {
              scanPolicy = {state: true};
            }
            const result = await this.getScanHosts(scanPolicy);
            hosts = result && result.hosts || [];
            // for now, only VPN devices use identities, so it's okay to consider identities identical to VPN devices
            // hosts = data.includeVPNNetworks ? hostManager.getActiveMACs().concat(IdentityManager.getAllIdentitiesGUID()) : hostManager.getActiveMACs();
          } else {
            hosts = [target];
          }
          break;
        }
        case "intf": {
          key = `intf:${target}`;
          const intfObj = sysManager.getInterfaceViaUUID(target);
          if (!intfObj)
            throw new Error(`Interface uuid ${target} is not found`);
          hosts = hostManager.getIntfMacs(target).concat(Object.entries(IdentityManager.getIdentitiesByNicName(intfObj.name)).flatMap(entry => Object.keys(entry[1]).map(uid => `${entry[0]}:${uid}`)));
          break;
        }
        case "tag": {
          key = `tag:${target}`;
          hosts = await hostManager.getTagMacs(target);
          break;
        }
        default:
          throw new Error(`Unrecognized type/target`);
      }
      hosts = hosts.filter(mac => !sysManager.isMyMac(mac));
      const sendTs = Math.floor(Date.now() / 1000);
      sem.sendEventToFireMain({
        type: "SubmitWeakPasswordScanTask",
        hosts: hosts,
        key: key,
      });

      try {
        await this._waitCondition(sendTs + 5,  async() => {
          const result = await this.getScanResult();
          if (!result.tasks) {
            return false;
          }
          return result.tasks[key] && (result.tasks[key].state == STATE_SCANNING || result.tasks[key].state == STATE_QUEUED);
      })} catch (err) {
        log.info('timeout waiting for task to start');
      }
      return this.getScanResult(1);
    });

    extensionManager.onGet("weakPasswordScanTasks", async (msg, data) => {
      return this.getScanResult(1);
    });

    extensionManager.onCmd("stopWeakPasswordScanTask", async (msg, data) => {
      const sendTs = Math.floor(Date.now() / 1000);
      sem.sendEventToFireMain({
        type: "StopWeakPasswordScanTask",
      });

      try {
        await this._waitCondition(sendTs + 10,  async() => {
          const result = await this.getScanResult();
          if (!result.tasks) {
            return true;
          }
          const pendingHosts = Object.values(result.tasks).filter(i => (i.state == STATE_SCANNING || i.state == STATE_QUEUED) );
          return pendingHosts.length == 0;
        })
      } catch (err) {
        log.info('timeout waiting for task to stop');
      }
      return this.getScanResult(1);
    });
  }

  async _waitCondition (deadline, conditionFunc) {
    return new Promise((resolve, reject) => {
      const itrv = setInterval(async () => {
        if (await conditionFunc()) {
          clearInterval(itrv);
          resolve();
        } else if (Date.now()/1000 > deadline) { // Timeout
          clearInterval(itrv);
          reject(new Error("timeout"));
        }
      }, 500);
    });
  }

  async _stopScanTask(key, target) {
      log.info("stopping task", key)
      if (!this.scheduledScanTasks[key])
        throw new Error(`Task on ${target} is not scheduled`);
      await lock.acquire(LOCK_TASK_QUEUE, async () => {
        const task = this.scheduledScanTasks[key];
        if (task.state === STATE_QUEUED || task.state === STATE_SCANNING) {
          task.state = STATE_STOPPED;
          task.ets = Date.now() / 1000;
        }
        for (const hostId of Object.keys(task.pendingHosts)) {
          const subTask = this.subTaskMap[hostId];
          if (!subTask) {
            log.info('stop scan task skipped, ignore dangling pending hosts', key, hostId, task.pendingHosts);
            continue
          }
          delete subTask.subscribers[key];
          if (_.isEmpty(subTask.subscribers)) {
            delete this.subTaskMap[hostId];
            delete this.subTaskRunning[hostId];
            if (subTask.pid)
              await this.killTask(subTask.pid);
            this.subTaskWaitingQueue = this.subTaskWaitingQueue.filter(h => h !== hostId);
          }
        }
      });
      await this.saveScanTasks();
}

  async killTask(pid) {
    const children = await execAsync(`pgrep -P ${pid}`).then((result) => result.stdout.trim().split("\n")).catch((err) => null);
    if (!_.isEmpty(children)) {
      for (const child of children)
        await this.killTask(child);
    }
    await execAsync(`sudo kill -SIGINT ${pid}`).catch((err) => {
      log.error(`Failed to kill task pid ${pid}`, err.message);
    });
  }

  async submitTask(key, hosts) {
    log.info(`submit weak_pasword task on ${key} with hosts ${hosts}`);
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      if (_.has(this.scheduledScanTasks, key) && (this.scheduledScanTasks[key].state === STATE_QUEUED || this.scheduledScanTasks[key].state === STATE_SCANNING))
        return;
      const task = {state: STATE_QUEUED, ts: Date.now() / 1000};
      this.scheduledScanTasks[key] = task;
      task.pendingHosts = {};
      for (const host of hosts)
        task.pendingHosts[host] = 1;
      task.results = [];
      if (_.isEmpty(task.pendingHosts)) {
        task.state = STATE_COMPLETE;
        task.ets = Date.now() / 1000;
        return;
      }
      for (const host of hosts) {
        if (_.has(this.subTaskRunning, host) || this.subTaskWaitingQueue.includes(host))
          continue;
        this.subTaskWaitingQueue.push(host);
        if (!_.has(this.subTaskMap, host))
          this.subTaskMap[host] = {subscribers: {}};
        this.subTaskMap[host].subscribers[key] = 1;
      }
    }).catch((err) => {
      log.error(`Failed to submit task on ${key} with hosts ${hosts}`, err.message);
    });
  }

  async scheduleTask() {
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      while (Object.keys(this.subTaskRunning).length < MAX_CONCURRENT_TASKS && !_.isEmpty(this.subTaskWaitingQueue)) {
        const hostId = this.subTaskWaitingQueue.shift();
        this.subTaskRunning[hostId] = 1;
        const subTask = this.subTaskMap[hostId];
        if (subTask) {
          const subscribers = subTask.subscribers;
          for (const key of Object.keys(subscribers)) {
            const task = this.scheduledScanTasks[key];
            if (task)
              task.state = STATE_SCANNING;
          }
        }
        this.scanHost(hostId).catch((err) => {
          log.error(`Failed to scan host ${hostId}`, err.message);
        }).finally(() => this.scheduleTask());
      }

      if (Object.keys(this.subTaskRunning).length == 0) {
        await this._updateRunningStatus(STATE_COMPLETE);
      }
    });
  }

  async scanHost(hostId) {
    const weakPasswords = [];
    const ips = [];
    if (IdentityManager.isGUID(hostId)) {
      Array.prototype.push.apply(ips, IdentityManager.getIPsByGUID(hostId).filter((ip) => {
        // do not scan IP range on identities, e.g., peer allow IPs on wireguard peers
        let addr = new Address4(ip);
        if (addr.isValid()) {
          return addr.subnetMask === 32;
        } else {
          addr = new Address6(ip);
          if (addr.isValid())
            return addr.subnetMask === 128;
        }
        return false;
      }));
    } else {
      const host = hostManager.getHostFastByMAC(hostId);
      if (host && _.has(host, ["o", "ipv4Addr"]))
        ips.push(host.o.ipv4Addr);
    }
    const subTask = this.subTaskMap[hostId];
    for (const portId of this.supportPorts) {
      const config = bruteConfig[portId];
      const terminated = !_.has(this.subTaskMap, hostId);
      if (terminated) {
        log.info(`Host scan ${hostId} is terminated by stopWeakPasswordScanTask API`);
        break;
      }
      if (config && !terminated) {
        for (const ip of ips) {
          log.info(`Scan host ${hostId} ${ip} on port ${portId} ...`);
          const results = await this.nmapGuessPassword(ip, config, hostId);
          if (_.isArray(results)) {
            for (const r of results)
              weakPasswords.push(Object.assign({}, r, { protocol: config.protocol, port: config.port, serviceName: config.serviceName }));
          }
        }
      }
    }
    const result = Object.assign({}, { host: hostId, ts: Date.now() / 1000, result: weakPasswords });
    await this.saveToRedis(hostId, result);
    await this.setLastCompletedScanTs();
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      delete this.subTaskRunning[hostId];
      if (subTask) {
        const subscribers = subTask.subscribers;
        for (const key of Object.keys(subscribers)) {
          const task = this.scheduledScanTasks[key];
          if (task) {
            delete task.pendingHosts[hostId];
            task.results.push(result);
            if (_.isEmpty(task.pendingHosts)) {
              log.info(`All hosts on ${key} have been scanned, scan complete on ${key}`);
              const ets = Date.now() / 1000;
              await this.sendNotification(key, ets, task.results);
              task.state = STATE_COMPLETE;
              task.ets = ets;
            }
          }
        }
      }
      await this.saveScanTasks();
      delete this.subTaskMap[hostId];
    });
  }

  async sendNotification(key, ets, results) {
    const numOfWeakPasswords = results.map(r => !_.isEmpty(r.result) ? r.result.length : 0).reduce((total, item) => total + item, 0);
    const timezone = sysManager.getTimezone();
    const time = (timezone ? moment.unix(ets).tz(timezone) : moment.unix(ets)).format("hh:mm A");
    sem.sendEventToFireApi({
      type: 'FW_NOTIFICATION',
      titleKey: 'NOTIF_WEAK_PASSWORD_SCAN_COMPLETE_TITLE',
      bodyKey: `NOTIF_WEAK_PASSWORD_SCAN_COMPLETE_${numOfWeakPasswords === 0 ? "NOT_" : numOfWeakPasswords > 1 ? "MULTI_" : "SINGLE_"}FOUND_BODY`,
      titleLocalKey: `WEAK_PASSWORD_SCAN_COMPLETE`,
      bodyLocalKey: `WEAK_PASSSWORD_SCAN_COMPLETE_${numOfWeakPasswords === 0 ? "NOT_" : numOfWeakPasswords > 1 ? "MULTI_" : "SINGLE_"}FOUND`,
      bodyLocalArgs: [numOfWeakPasswords, time],
      payload: {
        weakPasswordCount: numOfWeakPasswords,
        time
      },
      category: Constants.NOTIF_CATEGORY_WEAK_PASSWORD_SCAN
    });
  }

  _getLatestNumTaskKeys(tasks, maxNum) {
    return Object.entries(tasks).sort((a,b) => {return (a[1].ts || 0) - (b[1].ts || 0)}).splice(Object.keys(tasks).length-maxNum, maxNum).map(i=>i[0]);
  }

  async _cleanTasks(maxNum=10) {
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      let deleted = false;
      const len = Object.keys(this.scheduledScanTasks).length;
      if ( len > maxNum) { // only keep recent maxNum results
        const keys = Object.entries(this.scheduledScanTasks).filter(item => item[1].state != STATE_SCANNING && item[1].state != STATE_QUEUED).sort((a,b) => {return (a[1].ts || 0) - (b[1].ts || 0)}).splice(0,len-maxNum).map(i=>i[0]);
        for (const key of keys) {
          log.debug("delete scan task", key);
          delete this.scheduledScanTasks[key];
          deleted = true;
        }
      }
      for (const key of Object.keys(this.scheduledScanTasks)) {
        const ets = this.scheduledScanTasks[key].ets;
        if (ets && ets < Date.now() / 1000 - 86400*30) {
          log.debug("delete scan task", key);
          delete this.scheduledScanTasks[key];
          deleted = true;
        }
      }
      if (deleted) {
        await this.saveScanTasks();
      }
    });
  }

  getTasks() {
    return this.scheduledScanTasks || {};
  }

  async saveToRedis(hostId, result) {
    await rclient.setAsync(`weak_password_scan:${hostId}`, JSON.stringify(result));
    await rclient.expireAsync(`weak_password_scan:${hostId}`, TTL_SEC);
  }

  async saveScanTasks() {
    const tasks = this.getTasks();
    await rclient.hsetAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT, "tasks", JSON.stringify(tasks));
  }

  async setLastCompletedScanTs() {
    await rclient.hsetAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT, "lastCompletedScanTs", Math.floor(Date.now() / 1000));
  }

  getLatestNumTasks(tasks, maxNum) {
    let lastTasks = {};
    const lastKeys = this._getLatestNumTaskKeys(tasks, maxNum);
    for (const key of lastKeys) {
      lastTasks[key] = tasks[key]
    }
    return lastTasks
  }

  async getScanResult(latestNum=-1, maxResult=-1) { // -1 for all
    const result = await rclient.hgetallAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT);
    if (!result)
      return {};
    if (_.has(result, "tasks"))
      result.tasks = JSON.parse(result.tasks);
    if (_.has(result, "lastCompletedScanTs"))
      result.lastCompletedScanTs = Number(result.lastCompletedScanTs);

    if (latestNum > 0 && result.tasks && Object.keys(result.tasks).length > 0) {
      const lastTasks = this.getLatestNumTasks(result.tasks, latestNum);
      if (Object.keys(lastTasks).length > 0) {
        result.tasks = lastTasks;
      }
    }
    if (maxResult > 0) {
      result.tasks = this._limitResult(result.tasks, maxResult);
    }
    return result;
  }

  _limitResult(tasks, maxResult) {
    return Ranges.limitInternalScanResult(tasks, maxResult);
  }

  async getScanHosts(policy) {
    const key = 'cron_'+ (policy.ts ? policy.ts : Date.now()/1000);
    let hosts = {};

    // 1. get network policy
    const networks = await networkProfileManager.refreshNetworkProfiles(true);
    for (const uuid in networks) {
      const p = await networks[uuid].getPolicyAsync(policyKeyName);
      if (p && p.state !== false) { // false to ignore state
        const macs = hostManager.getIntfMacs(uuid);
        for (const m of macs) {
          hosts[m] = p.state + '';
        }
      }
    }
    log.debug("get scan network hosts", hosts);

    // 2. get tag policy, override network policy
    const tags = await tagManager.getPolicyTags(policyKeyName);
    for (const tag of tags) {
      const p = await tag.getPolicyAsync(policyKeyName);
      if (p && p.state !== false) {
        const macs = await hostManager.getTagMacs(tag.o.uid);
        for (const m of macs) {
          hosts[m] = p.state + '';
        }
      }
    }
    log.debug("get scan tag hosts", hosts);

    // 3. get host policy, override tag policy
    const devices = await hostManager.getActiveHosts() || [];
    for (const h of devices) {
      const devPolicy = await h.getPolicyAsync(policyKeyName);
      if ((devPolicy && devPolicy.state !== false) || !hosts.hasOwnProperty(h.o.mac) ) {
        hosts[h.o.mac] = devPolicy && (devPolicy.state + '');
      }
    }
    log.debug("get scan device hosts", hosts);

    // apply default devices
    let scanHosts = [];
    for (const mac in hosts) {
      // force skip null
      if (hosts[mac] === 'true' || (policy.state && hosts[mac] !== 'null')) {
        scanHosts.push(mac);
      }
    }
    // apply vpn devices
    if (policy.includeVPNNetworks) {
      scanHosts = scanHosts.concat(IdentityManager.getAllIdentitiesGUID());
    }
    log.debug("get scan all hosts", scanHosts);

    scanHosts = _.uniq(scanHosts.filter(mac => !sysManager.isMyMac(mac)));
    return {key: key, hosts: scanHosts}
  }

  async applyPolicy(host, ip, policy) {
    await lock.acquire(LOCK_APPLY_INTERNAL_SCAN_POLICY, async () => {
      this.applyScanPolicy(host, ip, policy);
    }).catch((err) => {
      log.error(`failed to get lock to apply ${featureName} policy`, err.message);
    });
  }

  // policy = { state: true, cron: '0 0 * * *', ts: 1494931469}
  async applyScanPolicy(host, ip, policy) {
    if (host.constructor.name != hostManager.constructor.name) { // only need to handle system-level
      return;
    }
    log.info(`Applying InternalScanSensor policy, host ${host.constructor.name}, ip ${ip}, policy (${JSON.stringify(policy)})`);
    const result = await this._applyPolicy(host, ip, policy);
    if (result && result.err) {
      // if apply error, reset to previous saved policy
      log.error('fail to apply policy,', result.err);
      if (this.policy) {
        await rclient.hsetAsync('policy:system', policyKeyName, JSON.stringify(this.policy));
      }
      return;
    }
    this.policy = policy;
  }

  async _updateRunningStatus(status) {
    log.verbose("update running status set to", status)
    return await rclient.evalAsync('if redis.call("get", KEYS[1]) == ARGV[1] then return 0 else redis.call("set", KEYS[1], ARGV[1]) return 1 end', 1, 'weak_password_scan:status', status);
  }

  async checkRunningStatus() {
    if (Object.keys(this.subTaskRunning).length == 0) {
      await this._updateRunningStatus(STATE_COMPLETE);
    }
  }

  async _applyPolicy(host, ip, policy) {
    if (!policy) {
      return {err: 'policy must be specified'};
    }
    const tz = sysManager.getTimezone();
    const cron = policy.cron;
    if (!cron) {
      return {err: 'cron expression must be specified'};
    }
    try {
      var interval = cronParser.parseExpression(cron, {tz});
      const itvSec = interval.next()._date.unix() - interval.prev()._date.unix();
      if (itvSec < MIN_CRON_INTERVAL) {
        return {err: `cron expression not allowed (frequency out of range): ${cron}`};
      }
    } catch (err) {
      return {err: `cron expression invalid format: ${cron}, ${err.message}`};
    }

    if (this.scanJob) {
      this.scanJob.stop();
    }

    this.scanJob = new CronJob(cron, async() => {
      if (!this.featureOn) {
        log.info(`feature ${featureName} is off`);
        return;
      }

      const result = await this._updateRunningStatus(STATE_SCANNING);
      if (result != 1) {
        log.info('scan task is running, skip');
        return;
      }

      const {key, hosts} = await this.getScanHosts(policy);
      if (!hosts || hosts.length == 0) {
        log.info('cron task finished, no target hosts found');
      }
      log.info(`start cron weak_password_scan job ${policy.cron}: ${hosts}`);
      await this.submitTask(key, hosts);
      this.scheduleTask();
      await this.saveScanTasks();
    }, () => {}, true, tz);
    return;
  }

  async checkDictionary() {
    let mkdirp = util.promisify(require('mkdirp'));
    const dictShaKey = "scan:config.sha256";
    const redisShaData = await rclient.getAsync(dictShaKey);
    const data = await bone.hashsetAsync("scan:config");
    log.debug('[checkDictionary]', data);
    const boneShaData = crypto.createHash('sha256').update(data).digest('hex');

    //let boneShaData = Date.now() / 1000;
    if (boneShaData && boneShaData != redisShaData) {
      await rclient.setAsync(dictShaKey, boneShaData);

      log.info(`Loading dictionary from cloud...`);
      if (data && data != '[]') {
        try {
          await mkdirp(scanConfigPath);
        } catch (err) {
          log.error("Error when mkdir:", err);
          return;
        }

        const dictData = JSON.parse(data);
        if (!dictData) {
          log.error("Error to parse scan config");
          return;
        }
        // process customCreds, commonCreds
        await this._process_dict_creds(dictData);

        // process extraConfig (http-form-brute)
        await this._process_dict_extras(dictData.extraConfig);
      } else {
        // cleanup
        await this._cleanup_dict_creds();
        await this._cleanup_dict_extras();
      }
    }
  }

  async _process_dict_creds(dictData) {
    const commonUser = dictData.commonCreds && dictData.commonCreds.usernames || [];
    const commonPwds = dictData.commonCreds && dictData.commonCreds.passwords || [];
    const commonCreds = dictData.commonCreds && dictData.commonCreds.creds || [];

    const customCreds = dictData.customCreds;
    let newCredFnames = [];
    let newUserFnames = [];
    let newPwdFnames = [];

    if (customCreds) {
      for (const key of Object.keys(customCreds)) {
        // eg. {firewalla}/run/scan_config/*_users.lst
        let scanUsers = customCreds[key].usernames || [];
        if (_.isArray(scanUsers) && _.isArray(commonUser)) {
          scanUsers.push.apply(scanUsers, commonUser);
        }
        if (scanUsers.length > 0) {
          const txtUsers = _.uniqWith(scanUsers, _.isEqual).join("\n");
          if (txtUsers.length > 0) {
            newUserFnames.push(key.toLowerCase() + "_users.lst");
            await fsp.writeFile(scanConfigPath + "/" + key.toLowerCase() + "_users.lst", txtUsers);
          }
        }

        // eg. {firewalla}/run/scan_config/*_pwds.lst
        let scanPwds = customCreds[key].passwords || [];
        if (_.isArray(scanPwds) && _.isArray(commonPwds)) {
          scanPwds.push.apply(scanPwds, commonPwds);
        }
        if (scanPwds.length > 0) {
          const txtPwds = _.uniqWith(scanPwds, _.isEqual).join("\n");
          if (txtPwds.length > 0) {
            newPwdFnames.push(key.toLowerCase() + "_pwds.lst");
            await fsp.writeFile(scanConfigPath + "/" + key.toLowerCase() + "_pwds.lst", txtPwds);
          }
        }

        // eg. {firewalla}/run/scan_config/*_creds.lst
        let scanCreds = customCreds[key].creds || [];
        if (_.isArray(scanCreds) && _.isArray(commonCreds)) {
          scanCreds.push.apply(scanCreds, commonCreds);
        }
        if (scanCreds.length > 0) {
          const txtCreds = _.uniqWith(scanCreds.map(i => i.user+'/'+i.password), _.isEqual).join("\n");
          if (txtCreds.length > 0) {
            newCredFnames.push(key.toLowerCase() + "_creds.lst");
            await fsp.writeFile(scanConfigPath + "/" + key.toLowerCase() + "_creds.lst", txtCreds);
          }
        }
      }
    }
    // remove outdated *.lst
    await this._clean_diff_creds(scanConfigPath, '_users.lst', newUserFnames);
    await this._clean_diff_creds(scanConfigPath, '_pwds.lst', newPwdFnames);
    await this._clean_diff_creds(scanConfigPath, '_creds.lst', newCredFnames);
  }

  async _process_dict_extras(extraConfig) {
    if (!extraConfig) {
      return;
    }
    await rclient.hsetAsync('sys:config', 'weak_password_scan', JSON.stringify(extraConfig));
  }

  async _clean_diff_creds(dir, suffix, newFnames) {
    const fnames = await this._list_suffix_files(scanConfigPath, suffix);
    const diff = fnames.filter(x => !newFnames.includes(x));
    const rmFiles = diff.map(file => {return fpath.join(dir, file)});
    log.debug(`rm diff files *${suffix}`, rmFiles);
    for (const filepath of rmFiles) {
      await execAsync(`rm -f ${filepath}`).catch(err => {log.warn(`fail to rm ${filepath},`, err.stderr)});
    }
  }

  async _cleanup_dict_creds() {
    await this._remove_suffix_files(scanConfigPath, '_creds.lst');
    await this._remove_suffix_files(scanConfigPath, '_users.lst');
    await this._remove_suffix_files(scanConfigPath, '_pwds.lst');
  }

  async _list_suffix_files(dir, suffix) {
    const filenames = await fsp.readdir(dir);
    const fnames = filenames.filter(name => {return name.endsWith(suffix)});
    log.debug(`ls ${dir} *${suffix}`, fnames);
    return fnames;
  }

  async _remove_suffix_files(dir, suffix) {
    const filenames = await this._list_suffix_files(dir, suffix);
    const rmFiles = filenames.map(file => {return fpath.join(dir, file)});
    for (const filepath of rmFiles) {
      await execAsync(`rm -f ${filepath}`).catch(err => {log.warn(`fail to rm ${filepath},`, err.stderr)});
    }
  }

  async _cleanup_dict_extras() {
    await rclient.hdelAsync('sys:config', 'weak_password_scan');
  }

  _getCmdStdout(cmd, subTask) {
    return new Promise((resolve, reject) => {
      const r = cp.exec(cmd, (error, stdout, stderr) => {
        if (error) {
          reject(error)
        } else if (stderr.length > 0) {
          reject(stderr)
        } else {
          resolve(stdout)
        }
      })
      subTask.pid = r.pid;
    })
  }

  static multiplyScriptArgs(scriptArgs, extras) {
    let argList = [];
    for (const extra of extras) {
      let newArgs = scriptArgs.slice(0); // clone scriptArgs
      const {path, method, uservar, passvar} = extra;
      if (path) {
        newArgs.push('http-form-brute.path='+path);
      }
      if (method) {
        newArgs.push('http-form-brute.method='+method);
      }
      if (uservar) {
        newArgs.push('http-form-brute.uservar='+uservar);
      }
      if (passvar) {
        newArgs.push('http-form-brute.passvar='+passvar);
      }
      argList.push(newArgs);
    }
    return argList;
  }

  formatNmapCommand(ipAddr, port, cmdArg, scriptArgs) {
    if (scriptArgs && scriptArgs.length > 0) {
      cmdArg.push(util.format('--script-args %s', scriptArgs.join(',')));
    }
    // a bit longer than unpwdb.timelimit in script args
    return util.format('sudo timeout 5430s nmap -n -p %s %s %s -oX - | %s', port, cmdArg.join(' '), ipAddr, xml2jsonBinary);
  }

  async _genNmapCmd_default(ipAddr, port, scripts) {
    let nmapCmdList = [];
    for (const bruteScript of scripts) {
      let cmdArg = [];
      // customized http-brute
      let customHttpBrute = false;
      let customMysqlBrute = false;
      if (this.config.strict_http === true && bruteScript.scriptName == 'http-brute') {
        if (await fsp.access(httpBruteScript, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          customHttpBrute = true;
        }
      }
      if (this.config.mysql8 === true && bruteScript.scriptName == 'mysql-brute') {
        if (await fsp.access(libmysqlclientSO, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          if (await fsp.access(mysqlBruteScript, fs.constants.F_OK).then(() => true).catch((err) => false)) {
            customMysqlBrute = true;
          }
        }
      }

      if (customHttpBrute === true) {
        cmdArg.push(util.format('--script %s', httpBruteScript));
      } else if (customMysqlBrute === true) {
        cmdArg.push(util.format('--script %s', mysqlBruteScript));
      } else {
        cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      }
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }
      let scriptArgs = [];
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      const cmd = this.formatNmapCommand(ipAddr, port, cmdArg, scriptArgs);
      nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
    }
    return nmapCmdList;
  }

  async _genNmapCmd_credfile(ipAddr, port, serviceName, scripts, extraConfig) {
    let nmapCmdList = [];
    const httpformbruteConfig = extraConfig && extraConfig['http-form-brute'];

    for (const bruteScript of scripts) {
      let scriptArgs = [];
      let needCustom = false;
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      if (bruteScript.scriptName.indexOf("brute") > -1) {
        const credsFile = scanConfigPath + "/" + serviceName.toLowerCase() + "_creds.lst";
        if (await fsp.access(credsFile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          scriptArgs.push("brute.mode=creds,brute.credfile=" + credsFile);
          needCustom = true;
        }
      }
      if (needCustom == false) {
        continue;
      }

      // nmap -p 23 --script telnet-brute --script-args telnet-brute.timeout=8s,brute.mode=creds,brute.credfile=./creds.lst 192.168.1.103
      let cmdArg = [];
      cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }

      // extends to a list of nmap commands, set http-form-brute script-args
      if (bruteScript.scriptName == 'http-form-brute') {
        if (httpformbruteConfig) {
          const dupArgs = InternalScanSensor.multiplyScriptArgs(scriptArgs, httpformbruteConfig);
          for (const newArgs of dupArgs) {
            const cmd = this.formatNmapCommand(ipAddr, port, cmdArg.slice(0), newArgs);
            nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
          }
          continue;
        }
      }

      const cmd = this.formatNmapCommand(ipAddr, port, cmdArg, scriptArgs);
      nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
    }
    return nmapCmdList;
  }

  async _genNmapCmd_userpass(ipAddr, port, serviceName, scripts, extraConfig) {
    let nmapCmdList = [];
    const httpformbruteConfig = extraConfig && extraConfig['http-form-brute'];

    for (const bruteScript of scripts) {
      let scriptArgs = [];
      let needCustom = false;
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      if (bruteScript.scriptName.indexOf("brute") > -1) {
        const scanUsersFile = scanConfigPath + "/" + serviceName.toLowerCase() + "_users.lst";
        if (await fsp.access(scanUsersFile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          scriptArgs.push("userdb=" + scanUsersFile);
          needCustom = true;
        }
        const scanPwdsFile = scanConfigPath + "/" + serviceName.toLowerCase() + "_pwds.lst";
        if (await fsp.access(scanPwdsFile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          scriptArgs.push("passdb=" + scanPwdsFile);
          needCustom = true;
        }
      }
      if (needCustom == false) {
        continue;
      }

      // nmap -p 22 --script telnet-brute --script-args telnet-brute.timeout=8s,userdb=./userpass/myusers.lst,passdb=./userpass/mypwds.lst 192.168.1.103
      let cmdArg = [];
      cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }

      // extends to a list of nmap commands, set http-form-brute script-args
      if (bruteScript.scriptName == 'http-form-brute') {
        if (httpformbruteConfig) {
          const dupArgs = InternalScanSensor.multiplyScriptArgs(scriptArgs, httpformbruteConfig);
          for (const newArgs of dupArgs) {
            const cmd = this.formatNmapCommand(ipAddr, port, cmdArg.slice(0), newArgs);
            nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
          }
          continue;
        }
      }

      const cmd = this.formatNmapCommand(ipAddr, port, cmdArg, scriptArgs);
      nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
    }
    return nmapCmdList;
  }

  async genNmapCmdList(ipAddr, port, serviceName, scripts) {
    let nmapCmdList = []; // all nmap commands to run

    // prepare extra configs in advance (http-form-brute)
    const data = await rclient.hgetAsync('sys:config', 'weak_password_scan');
    const extraConfig = JSON.parse(data);

    // 1. compose default userdb/passdb (NO apply extra configs)
    const defaultCmds = await this._genNmapCmd_default(ipAddr, port, scripts);
    if (defaultCmds.length > 0) {
      nmapCmdList = nmapCmdList.concat(defaultCmds);
    }

    // 2. compose customized credfile if necessary
    const credsCmds = await this._genNmapCmd_credfile(ipAddr, port, serviceName, scripts, extraConfig);
    if (credsCmds.length > 0) {
      nmapCmdList = nmapCmdList.concat(credsCmds);
    }

    // 3. compose customized userdb/passdb if necessary
    const userpassCmds = await this._genNmapCmd_userpass(ipAddr, port, serviceName, scripts, extraConfig);
    if (userpassCmds.length > 0) {
      nmapCmdList = nmapCmdList.concat(userpassCmds);
    }
    return nmapCmdList;
  }

  async nmapGuessPassword(ipAddr, config, hostId) {
    const { port, serviceName, protocol, scripts } = config;
    let weakPasswords = [];
    const initTime = Date.now() / 1000;

    const nmapCmdList = await this.genNmapCmdList(ipAddr, port, serviceName, scripts);
    log.debug("[nmapCmdList]", nmapCmdList.map(i=>i.cmd));

    // run nmap commands
    for (const nmapCmd of nmapCmdList) {
      const subTask = this.subTaskMap[hostId];
      // check if hostId exists in subTaskMap for each loop iteration, in case it is stopped halfway, hostId will be removed from subTaskMap
      if (!subTask) {
        log.warn("total used time: ", Date.now() / 1000 - initTime, 'terminate of unknown hostId', hostId, weakPasswords);
        return weakPasswords;
      }

      log.info("Running command:", nmapCmd.cmd);
      const startTime = Date.now() / 1000;
      try {
        let result;
        try {
          result = await this._getCmdStdout(nmapCmd.cmd, subTask);
        } catch (err) {
          log.error("command execute fail", err);
          if (err.code === 130 || err.signal === "SIGINT") { // SIGINT from stopWeakPasswordScanTask API
            log.warn("total used time: ", Date.now() / 1000 - initTime, 'terminate of signal');
            return weakPasswords;
          }
          continue;
        }
        let output = JSON.parse(result);
        let findings = null;
        if (nmapCmd.bruteScript.scriptName == "redis-info") {
          findings = _.get(output, `nmaprun.host.ports.port.service.version`, null);
          if (findings != null) {
            weakPasswords.push({username: "", password: ""});  //empty password access
          }
        } else {
          findings = _.get(output, `nmaprun.host.ports.port.script.table.table`, null);
          if (findings != null) {
            if (findings.constructor === Object)  {
              findings = [findings];
            }

            for (const finding of findings) {
              let weakPassword = {};
              finding.elem.forEach((x) => {
                switch (x.key) {
                  case "username":
                    weakPassword.username = x["#content"];
                    break;
                  case "password":
                    weakPassword.password = x["#content"];
                    break;
                  default:
                }
              });

              // verify weak password
              if (this.config.skip_verify === true ) {
                log.debug("[nmapGuessPassword] skip weak password, config.skip_verify", this.config.skip_verify);
                weakPasswords.push(weakPassword);
              } else {
                if (await this.recheckWeakPassword(ipAddr, port, nmapCmd.bruteScript.scriptName, weakPassword) === true) {
                  log.debug("weak password verified", weakPassword, ipAddr, port, nmapCmd.bruteScript.scriptName);
                  weakPasswords.push(weakPassword);
                } else {
                  log.warn("weak password false-positive detected", weakPassword, ipAddr, port, nmapCmd.bruteScript.scriptName);
                }
              }
            }
          }
        }        
      } catch (err) {
        log.error("Failed to nmap scan:", err);
      }
      log.info("used Time: ", Date.now() / 1000 - startTime);
    }

    log.debug("total used time: ", Date.now() / 1000 - initTime, weakPasswords);

    // remove duplicates
    return _.uniqWith(weakPasswords, _.isEqual);
  }

  async recheckWeakPassword(ipAddr, port, scriptName, weakPassword) {
    switch (scriptName) {
      case "http-brute":
        const credfile = scanConfigPath + "/" + ipAddr + "_" + port + "_credentials.lst";
        const {username, password} = weakPassword;
        return await this.httpbruteCreds(ipAddr, port, username, password, credfile);
      default:
        return true;
    }
  }

  // check if username/password valid credentials
  async httpbruteCreds(ipAddr, port, username, password, credfile) {
    credfile = credfile || scanConfigPath + "/tmp_credentials.lst";
    let creds;
    if (password == '<empty>') {
      creds = `${username}/`;
    } else {
      creds = `${username}/${password}`;
    }
    await execAsync(`rm -f ${credfile}`); // cleanup credfile in case of dirty data
    await fsp.writeFile(credfile, creds);
    if (! await fsp.access(credfile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
        log.warn('fail to write credfile', ipAddr, port, username, credfile);
        return true; // if error, skip recheck
    }

    // check file content, skip to improve performance
    if (process.env.FWDEBUG) {
      const content = await execAsync(`cat ${credfile}`).then((result) => result.stdout.trim()).catch((err) => err.stderr);
      if (content != creds) {
        log.warn(`fail to write credfile, (user/pass=${username}/${password}, file=${content}, path ${credfile}`);
      }
    }

    let scriptName = 'http-brute';
    if (this.config.strict_http === true ) {
      if (await fsp.access(httpBruteScript, fs.constants.F_OK).then(() => true).catch((err) => false)) {
        scriptName = httpBruteScript;
      }
    }

    const cmd = `sudo nmap -n -p ${port} --script ${scriptName} --script-args unpwdb.timelimit=10s,brute.mode=creds,brute.credfile=${credfile} ${ipAddr} | grep "Valid credentials" | wc -l`
    const result = await execAsync(cmd);
    if (result.stderr) {
      log.warn(`fail to running command: ${cmd} (user/pass=${username}/${password}), err: ${result.stderr}`);
      return true;
    }

    await execAsync(`rm -f ${credfile}`); // cleanup credfile after finished
    log.info(`[httpbruteCreds] Running command: ${cmd} (user/pass=${username}/${password})`);
    return  result.stdout.trim() == "1"
  }
}

module.exports = InternalScanSensor;
