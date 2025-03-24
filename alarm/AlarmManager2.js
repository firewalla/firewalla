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

const log = require('../net2/logger.js')(__filename, 'info');
const Alarm = require('./Alarm.js');

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient();

const bone = require("../lib/Bone.js");

const util = require('util');

const moment = require('moment');

const fc = require('../net2/config.js')

const f = require('../net2/Firewalla.js');

const DNSManager = require('../net2/DNSManager.js');
const dnsManager = new DNSManager('info');

const getPreferredName = require('../util/util.js').getPreferredName

const delay = require('../util/util.js').delay;

const Policy = require('./Policy.js');

const PolicyManager2 = require('./PolicyManager2.js');
const pm2 = new PolicyManager2();

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();
const validator = require('validator');

let instance = null;

const alarmPendingKey = "alarm_pending";
const alarmActiveKey = "alarm_active";
const alarmArchiveKey = "alarm_archive";
const ExceptionManager = require('./ExceptionManager.js');
const exceptionManager = new ExceptionManager();

const tm = require('./TrustManager.js');

const Exception = require('./Exception.js');

const alarmIDKey = "alarm:id";
const alarmPrefix = "_alarm:";
const initID = 1;

const c = require('../net2/MessageBus.js');

const fConfig = require('../net2/config.js').getConfig();

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const Queue = require('bee-queue')
const LRU = require('lru-cache');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const alarmDetailPrefix = "_alarmDetail";

const _ = require('lodash');

const IntelManager = require('../net2/IntelManager.js')
const intelManager = new IntelManager('info');
const IdentityManager = require('../net2/IdentityManager.js');
const Constants = require('../net2/Constants.js');

const featureName = 'msp_sync_alarm';

// TODO: Support suppress alarm for a while

class alarmIndexCache {
  constructor() {
    this.cache = new LRU({max: 1000, maxAge: 3600 * 1000 * 24, updateAgeOnGet: true});
    this._lock = Promise.resolve();
    this._disabled = 0;
    this._size = 0;
  }

  has(type) {return this.cache.has(type)};
  get(type) {return this.cache.get(type)};
  keys() {return this.cache.keys()};
  values() {return this.cache.values()};
  length() {return this.list().length};
  // get all cached alarm IDs
  list() {
    return this.cache.values().reduce((r, v) => { return r.concat(Object.keys(v))}, []);
  }
  size() {
    return this._size;
  }
  reset() {
    this._disabled = 1;
    this._size = 0;
    return this.cache.reset();
  }
  // approximate size in bytes
  _sizeof(v) {
    const t = typeof v;
    switch (t) {
      case 'string':
        return 12 + 4 * Math.ceil(v.length / 4);
      case 'number':
        return 8;
      case 'boolean':
        return 4;
      case 'object':
        return this._objsize(v);
    }
    log.info("unexpected data type", t, v);
    return 0;
  }

  _objsize(v) {
    let s = 0;
    if (_.isArray(v)) {
      return v.reduce((r, v) => {return r + this._sizeof(v)}, 0);
    }
    for (const key in v) {
      s += this._sizeof(key);
      s += this._sizeof(v[key]);
    }
    return s;
  }

  async set(type, value, maxAge) {
    await this._lock;
    this._lock = (async () => {
      try {
        this.cache.set(type, value, maxAge);
        return Promise.resolve();
      } catch (err) {
        log.warn(`cannot set ${type} ${value} to cache`, err.message);
      } finally {
        this._lock = Promise.resolve();
      }
    })();
  };

  // alarm {type: '', aid: '1', state: '', ..}
  async add(alarm) {
    await this._lock;
    this._lock = (async () => {
      const atype = alarm.type;
      delete alarm.type;
      try {
        if (this.cache.keys().length == 0) {
          this._size = 0;
        }
        if (!this.cache.has(atype)) {
          this.cache.set(atype, {});
          this._size += this._sizeof(atype);
        };
        let item = this.cache.get(atype);
        if (item[alarm.aid]) {
          this._size -= this._sizeof(item[alarm.aid]);
        }
        item[alarm.aid] = alarm;
        this._size += this._sizeof(alarm);
        if (this._size >= 5000000) { // 5m
          log.warn(`[high memory usage] alarm cache consumes approximate ${this._size} bytes of memory`);
        }
        this.cache.set(atype, item);
        return Promise.resolve();
      } catch (err) {
        log.warn(`cannot add alarm ${atype} index cache`, alarm, err.message);
      } finally {
        this._lock = Promise.resolve();
      }
    })();
  }

  // alarm {type: '', aid: '1'}
  async remove(aid) {
    await this._lock;
    this._lock = (async () => {
      try {
        let atypes = this.cache.keys();
        if (!atypes || atypes.length == 0) {
          this._size = 0;
          return;
        }
        for (const atype of atypes) {
          const item = this.cache.get(atype);
          if (!item || !_.isObject(item)) {
            log.info(`skip outdated alarm cache type ${atype}`);
            this.cache.delete(atype);
            continue;
          }
          if (item[aid]) this._size -= this._sizeof(item[aid]);
          delete item[aid];
          // clear top-level key
          if (Object.keys(item).length == 0) {
            this.cache.del(atype);
            this._size -= this._sizeof(atype);
          }
          this.cache.set(atype, item);
        }
        return Promise.resolve();
      } catch (err) {
        log.warn(`cannot remove alarm ${aid} from cache`, err.message);
      } finally {
        // Ensure the mutex is released even if an error occurs
        this._lock = Promise.resolve();
      }
    })();
  }
}

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
      this.publisher = new c('info');
      this.indexCache = new alarmIndexCache();

      this.setupAlarmQueue();

      if (f.isApi()) {
        this.refreshAlarmCache();
        setInterval(() => {
          this.refreshAlarmCache();
        }, 3600000) // refresh alarm cache every 60m

        sclient.subscribe("alarm:updateCache");
        sclient.subscribe("alarm:removeCache");
        sclient.on("message", (channel, message) => {
          switch (channel) {
            case "alarm:updateCache": {
              log.info('received event alarm:updateCache', message);
              const data = JSON.parse(message);
              this._updateAlarmCache(data);
              break;
            }
            case "alarm:removeCache": {
              log.info('received event alarm:removeCache', message);
              const data = JSON.parse(message);
              this._deleteAlarmCache(data);
              break;
            }
          }
        });
      }

      if (f.isMain()) {
        // clean timeout pending alarms every 60s
        setInterval(() => {
          this.cleanPendingQueue();
        }, 60000);

        sclient.subscribe("config:feature:dynamic:disable");
        sclient.subscribe("alarm:create");
        sclient.subscribe("alarm:mspsync");

        sclient.on("message", (channel, message) => {
          switch (channel) {
            case "config:feature:dynamic:disable": {
              if (message === featureName) {
                log.info('received event config:feature:dynamic:disable', featureName)
                this.cleanPendingQueue();
              }
              break;
            }
            case "alarm:create": {
              log.info('received event alarm:create')
              this.createAlarm(JSON.parse(message));
              break;
            }
            case "alarm:mspsync": {
              log.info('received event alarm:mspsync')
              this._mspSyncAlarm(JSON.parse(message));
              break;
            }
          }
        });
      }
    }
    return instance;
  }

  async __updateCache(aid) {
    const r = await rclient.hmgetAsync(alarmPrefix + aid, 'type', 'aid', 'state', 'alarmTimestamp');
    const a = {type: r[0], aid: r[1], state: r[2] || '', ts: Number(r[3]) || 0};
    if (await rclient.zscoreAsync(alarmArchiveKey, aid) !== null) a.archived = 1;
    await this.indexCache.add(a);
  }

  async _updateAlarmCache(data) {
    if (data.aids) {
      for (const aid of data.aids) {
        await this.__updateCache(aid);
      }
    }
    if (data.aid) {
      await this.__updateCache(data.aid);
    }
  }

  async _deleteAlarmCache(data) {
    if (data.aid) {
      await this.indexCache.remove(data.aid);
    }
    if (data.aids) {
      for (const aid of data.aids) {
       await this.indexCache.remove(aid);
      }
    }
  }

  async _fallbackAlarmCache(types) {
    if (!types || !_.isArray(types)) return true;

    let unseen = false;
    for (const atype of types) {
      if (!this.indexCache.has(atype)) {
        // try to cache alarm type, cache should already be enabled
        await this.indexCache.set(atype, {});
        unseen = true;
      }
    }
    if (unseen) await this._syncUnseenAlarmCache();

    for (const atype of types) {
      if (!this.indexCache.has(atype)) return true;
    }
    return false;
  }

  async _syncUnseenAlarmCache() {
    // only check alarms not been cached
    const data = await this.loadAlarmIDs();
    const alarmIds = Object.values(data).flat();
    const cachedAids = this.indexCache.list();
    const unseenAids = alarmIds.filter( i => cachedAids.indexOf(i) == -1);
    if (unseenAids.length == 0) return;
    let multi = rclient.multi();
    unseenAids.map((aid) => {
      multi.hmget(alarmPrefix + aid, 'type', 'aid', 'state', 'alarmTimestamp');
    });
    const results = await multi.execAsync();
    for (const r of results) {
      if (!r[1]) {
        continue
      }
      const a = {type: r[0], aid: r[1], state: r[2] || '', ts: Number(r[3]) || 0};
      if (data.archivedAlarmIDs.indexOf(r[1]) >= 0) a.archived = 1;
      await this.indexCache.add(a);
    }
  }

  async refreshAlarmCache() {
    const disabled = await rclient.getAsync(Constants.REDIS_KEY_ALARM_CACHED) == "0";
    if (disabled) {
      log.info("alarm cache disabled");
      this.indexCache.reset();
      return;
    }
    try {
        const start = Date.now();
        const data = await this.loadAlarmIDs();
        const alarmIds = Object.values(data).flat();
        let multi = rclient.multi();
        alarmIds.map((aid) => {
          multi.hmget(alarmPrefix + aid, 'type', 'aid', 'state', 'alarmTimestamp');
        });

        const results = await multi.execAsync();
        const rs_rt = Math.floor(Date.now()-start)/1000;

        // remove dead cache
        const cachedAids = this.indexCache.list();
        const deadAids = cachedAids.filter( i => alarmIds.indexOf(i) == -1);
        for (const aid of deadAids) {
          await this.indexCache.remove(aid);
        }
        // add current alarm
        for (const r of results) {
          if (!r[1]) {
            continue
          }
          const a = {type: r[0], aid: r[1], state: r[2] || '', ts: Number(r[3]) || 0};
          // archived alarms need additional mark
          if (data.archivedAlarmIDs.indexOf(r[1]) >= 0) a.archived = 1;
          await this.indexCache.add(a);
        }
        this.indexCache._disabled = 0;
        log.info(`Refresh alarm index ${this.indexCache.length()} items finished in ${Math.floor(Date.now()-start)/1000} (io ${rs_rt}) seconds (approximate size ${this.indexCache.size()} bytes)`)
    } catch (err) {
      log.error('Failed to refresh alarm index', err.message);
    }
  }

  async _mspSyncAlarm(data) {
    for (const cmd in data ) {
      await this.mspSyncAlarm(cmd, data[cmd]);
    }
  }

  async createAlarm(data) {
    if (!f.isMain()) {
      return;
    }
    if (!data) {
      log.warn('cannot create alarm, invalid parameters');
      return;
    }

    try {
      const alarm = this._genAlarm(await this._alignAlarmInfo(data));
      if (!alarm) {
        log.warn('cannot create alarm, invalid parameter type', data.type)
        return;
      }
      log.info('alarm:create', alarm);
      await this.enrichDeviceInfo(alarm);
      this.enqueueAlarm(alarm); // use enqueue to ensure no dup alarms
    } catch (err) {
      log.warn('cannot create alarm', err.message);
    }
  }

  async cleanPendingQueue() {
    const alarmIds = await rclient.zrangeAsync(alarmPendingKey, 0, -1);
    const timeout = parseFloat(_.get(fc.getConfig(), 'alarms.apply.default.timeout')) || 600;  // default 600s timeout, at least 60s
    const deadline = new Date() / 1000 - Math.max(timeout, 60);
    for (const aid of alarmIds) {
      try {
        const alarmKey = alarmPrefix + aid;
        if (await rclient.existsAsync(alarmKey) == 0) {
          log.warn('cannot get pending alarm detail, auto clean', aid);
          await rclient.zremAsync(alarmPendingKey, aid);
          pclient.publishAsync("alarm:removeCache", JSON.stringify({aid:aid}));
          continue;
        }
        const data = await rclient.hmgetAsync(alarmKey, 'state', 'alarmTimestamp');
        if (data.length < 2) {
          log.warn('cannot get pending alarm detail', aid);
          continue
        }
        // check timestamp
        const outdated = parseFloat(data[1]) < deadline;

        switch (data[0]) {
          case Constants.ST_INIT:
          case Constants.ST_PENDING: {
            if (!this.isAlarmSyncMspEnabled() || outdated ) {
              log.info('pending alarm fallback to active', aid);
              await this.activateAlarm({state: Constants.ST_READY, aid: aid, alarmTimestamp: data[1]}, {origin:{state: data[0]}, 'p.msp.decision':'timeout'});
            }
            break;
          }
          case Constants.ST_READY: {
            // activate immediately, normally active alarms should not in pending queue
            await this.activateAlarm({state: Constants.ST_READY, aid: aid, alarmTimestamp: data[1]}, {origin:{state: data[0]}});
            break;
          }
          case Constants.ST_ACTIVATED:
          case Constants.ST_IGNORE: {
            await rclient.zremAsync(alarmPendingKey, aid);
            break;
          }
          default: {
            log.warn('cannot handle pending alarms', aid, data);
            break;
          }
        }
      } catch (err) {
        log.error('fail to scan pending alarms', err.message);
      }
    }
  }

  isAlarmSyncMspEnabled() {
    return fc.isFeatureOn(featureName);
  }

  isCyberSecurityEnabled() {
    return fc.isFeatureOn("cyber_security")
  }

  isMuteAlarm(alarm) {
    // TODO: specify p.msp.type value if needed
    if (alarm.type == "ALARM_CUSTOMIZED_SECURITY" && alarm["p.msp.type"] && !this.isCyberSecurityEnabled() ) {
      log.info("Alarm category cyber_security is disabled", alarm);
      return true
    }
    return false
  }

  async setupAlarmQueue() {
    this.queue = new Queue(`alarm-${f.getProcessName()}`, {
      removeOnFailure: true,
      removeOnSuccess: true
    })

    this.queue.on('error', (err) => {
      log.error("Queue got err:", err)
    })

    this.queue.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${job.action} failed with error ${err.message}`);
    });

    this.queue.destroy(() => {
      log.info("alarm queue is cleaned up")
    })

    this.queue.process(async (job, done) => {
      const event = job.data;
      const alarm = this.jsonToAlarm(event.alarm);
      if (this.isAlarmSyncMspEnabled()) {
        if (alarm["p.msp.ready"]) {
          this.applyConfig(alarm, ['state']);
        } else {
          this.applyConfig(alarm, []);
        }
      }

      if (this.isMuteAlarm(alarm)) {
        return;
      }

      log.debug('processing job', JSON.stringify(event))

      if (alarm["p.local.decision"] === "ignore") {
        log.info("Alarm ignored by p.local.decision:", alarm);
        return;
      }

      const action = event.action;

      switch (action) {
        case "create": {
          try {
            log.verbose("Try to create alarm:", event.alarm);
            let aid = await this.checkAndSaveAsync(alarm, event.profile);
            if (aid > 0) log.info(`Alarm ${aid} is created successfully`);
          } catch (err) {
            if (err.code === 'ERR_DUP_ALARM' ||
                err.code === 'ERR_BLOCKED_BY_POLICY_ALREADY' ||
                err.code === 'ERR_BLOCKED_BY_TRUST_ALREADY' ||
                err.code === 'ERR_COVERED_BY_EXCEPTION') {
              log.info("failed to create alarm:", err.message);
            } else {
              log.error("failed to create alarm:", err);
            }
          }

          done();

          break
        }

        default:
          log.error("unrecoganized alarm enforcement action:" + action)
          done()
          break
      }
    })

    return this.queue.ready();
  }

  createAlarmIDKey() {
    return rclient.setAsync(alarmIDKey, initID);
  }

  async getNextID() {
    const result = await rclient.getAsync(alarmIDKey);

    if (!result) {
      await this.createAlarmIDKey();
      return initID
    }

    return rclient.incrAsync(alarmIDKey);
  }

  async addToActiveQueue(alarm) {
    let score = parseFloat(alarm.alarmTimestamp);
    let id = alarm.aid;
    await rclient.zaddAsync(alarmActiveKey, score, id);
  }

  async addToPendingQueue(alarm) {
    let score = parseFloat(alarm.alarmTimestamp);
    return await rclient.zaddAsync(alarmPendingKey, 'NX', score, alarm.aid);
  }

  removeFromActiveQueueAsync(alarmID) {
    return rclient.zremAsync(alarmActiveKey, alarmID)
  }

  // chekc if required attributes present
  validateAlarm(alarm) {
    let keys = alarm.requiredKeys();
    for (var i = 0; i < keys.length; i++) {
      let k = keys[i];
      if (!alarm[k]) {
        // typically bug occurs if reaching this code block
        log.error("Invalid payload for " + alarm.type + ", missing " + k, new Error("").stack);
        log.error("Invalid alarm is: " + alarm);
        return false;
      }
    }

    return true;
  }

  createAlarmFromJson(json, callback) {
    callback = callback || function () { }

    callback(null, this.jsonToAlarm(json));
  }

  async updateAlarm(alarm) {
    if (!alarm instanceof Alarm.Alarm) alarm = this.jsonToAlarm(alarm)
    if (!alarm) throw new Error('Failed to create Alarm object')

    const alarmKey = alarmPrefix + alarm.aid;
    await rclient.hmsetAsync(alarmKey, alarm.redisfy())
    pclient.publishAsync("alarm:updateCache", JSON.stringify({aid:alarm.aid}));
    return alarm
  }

  async mspIgnoreAlarm(alarmID, options={}) {
    if (options.origin && options.origin.state == Constants.ST_IGNORE){
      return
    }
    let mspDec = 'ignore';
    if (options.origin && options.origin['p.msp.decision']) {
      mspDec = options.origin['p.msp.decision'] + ',' + mspDec;
    }
    await rclient.hsetAsync(alarmPrefix + alarmID, 'p.msp.decision', mspDec);
    await this.archiveAlarm(alarmID);
    await rclient.zremAsync(alarmPendingKey, alarmID);
  }

  async ignoreAlarm(alarmID, info) {
    log.info("Going to ignore alarm " + alarmID);
    const userInput = info.info;
    const matchAll = info.matchAll;
    const alarm = await this.getAlarm(alarmID)
    if (!alarm) {
      throw new Error(`Invalid alarm id: ${alarmID}`)
    }
    if (matchAll) {
      const relatedAlarmIds = await this.loadRelatedAlarms(alarm, userInput);
      for (const aid of relatedAlarmIds) {
        await this.archiveAlarm(aid)
      }
      return relatedAlarmIds
    } else {
      await this.archiveAlarm(alarm.aid)
      return [alarm.aid]
    }
  }

  async reportBug(alarmID, feedback) {
    log.info("Going to report feedback on alarm", alarmID, feedback);

    //      await this.ignoreAlarm(alarmID) // TODO: report issue to cloud
  }

  // Emmit Alarm:NewAlarm event, effectively create application notifications
  async notifAlarm(alarmID) {
    let alarm = await this.getAlarm(alarmID);
    if (!alarm) {
      log.error(`Invalid Alarm (id: ${alarmID})`)
      return;
    }

    // publish to others
    sem.sendEventToAll({
      type: "Alarm:NewAlarm",
      message: "A new alarm is generated",
      alarmID: alarm.aid
    });
  }

  // exclude extended info from basic info, these two info will be stored separately

  parseRawAlarm(alarm) {
    const alarmCopy = JSON.parse(JSON.stringify(alarm));
    const keys = Object.keys(alarmCopy);
    const extendedInfo = {};

    keys.forEach((key) => {
      if (key.startsWith("e.") || key.startsWith("r.")) {
        extendedInfo[key] = alarmCopy[key];
        delete alarmCopy[key];
      }
    });

    return { basic: alarmCopy, extended: extendedInfo };
  }

  async saveAlarm(alarm) {
    if (!(alarm instanceof Alarm.Alarm)) alarm = this.jsonToAlarm(alarm)
    if (!alarm) return
    // covnert to string to make it consistent
    if (!alarm.aid) alarm.aid = await this.getNextID() + ""

    const alarmKey = alarmPrefix + alarm.aid;

    for (const alarmKey in alarm) {
      const value = alarm[alarmKey];
      if (value === null || value === undefined) {
        delete alarm[alarmKey];
        continue;
      }

      // basic key or extended key
      if (alarmKey.startsWith("p.") || alarmKey.startsWith("e.")) {
        if (value && value.constructor && ["Object", "Array"].includes(value.constructor.name)) {
          // for hash or array, need to convert it to JSON string first
          alarm[alarmKey] = JSON.stringify(value);
        }
      }
    }

    const redisfied = alarm.redisfy()

    const { basic, extended } = this.parseRawAlarm(redisfied);

    await rclient.hmsetAsync(alarmKey, basic)

    let expiring = fConfig.sensors.OldDataCleanSensor.alarm.expires || 24 * 60 * 60 * 30;  // a month
    await rclient.expireatAsync(alarmKey, parseInt((+new Date) / 1000) + expiring);

    // add extended info, extended info are optional
    (async () => {
      const extendedAlarmKey = `${alarmDetailPrefix}:${alarm.aid}`;
      // if there is any extended info
      if (Object.keys(extended).length !== 0 && extended.constructor === Object) {
        await rclient.hmsetAsync(extendedAlarmKey, extended);
        await rclient.expireatAsync(extendedAlarmKey, parseInt((+new Date) / 1000) + expiring);
      }

    })().catch((err) => {
      log.error(`Failed to store extended data for alarm ${alarm.aid}, err: ${err}`);
    })

    // save pending
    if (this.isAlarmSyncMspEnabled() && alarm.state == Constants.ST_PENDING) {
      await this.addToPendingQueue(alarm);
    }
    pclient.publishAsync("alarm:updateCache", JSON.stringify({aid:alarm.aid}));
    return alarm.aid;
  }

  async removeAlarmAsync(alarmID) {
    await rclient.zremAsync(alarmPendingKey, alarmID);
    await rclient.zremAsync(alarmArchiveKey, alarmID);
    await this.removeFromActiveQueueAsync(alarmID);
    await this.deleteExtendedAlarm(alarmID);
    await rclient.unlinkAsync(alarmPrefix + alarmID);
    pclient.publishAsync("alarm:removeCache", JSON.stringify({aid:alarmID}));
  }

  async deleteMacRelatedAlarms(mac) {
    let alarms = await this.loadRecentAlarmsAsync(60 * 60 * 24 * 7);
    let related = alarms
      .filter(alarm => _.isString(alarm['p.device.mac']) &&
        alarm['p.device.mac'].toUpperCase() === mac.toUpperCase())
      .map(alarm => alarm.aid);

    if (related.length) {
      await rclient.zremAsync(alarmActiveKey, related);
      await rclient.unlinkAsync(related.map(id => alarmDetailPrefix + ':' + id));
      await rclient.unlinkAsync(related.map(id => alarmPrefix + id));
      pclient.publishAsync("alarm:removeCache", JSON.stringify({aids:related}));
    }
  }

  async dedup(alarm, profile) {
    // expirationTime managed within Alarm sub classes
    let duration = profile && profile.cooldown || alarm.getExpirationTime() || 15 * 60; // 15 minutes
    log.debug('dedup', duration, profile)

    const existingAlarms = await this.loadRecentAlarmsAsync(duration)

    let dups = existingAlarms
      .filter((a) => a != null && alarm.isDup(a));

    if (dups.length > 0) {
      const latest = dups[0].timestamp;
      const dupAlarmID = dups[0].aid;
      let cooldown = duration - (Date.now() / 1000 - latest);

      log.info(util.format(
        ':dedup: Latest alarm %s happened at %s, cooldown: %s / %s',
        dupAlarmID,
        new Date(latest * 1000).toLocaleString(),
        moment.duration(cooldown * 1000).humanize(), moment.duration(duration * 1000).humanize()
      ));

      return true
    } else {
      return false
    }
  }

  enqueueAlarm(alarm, retry = true, profile) {
    if (this.queue) {
      const job = this.queue.createJob({
        alarm,
        profile,
        action: "create"
      })
      job.timeout(60000).save((err) => {
        if (err) {
          log.error("Failed to create alarm job", err.message);
          if (err.message && err.message.includes("NOSCRIPT")) {
            // this is usually caused by unexpected redis restart and previously loaded scripts are flushed
            log.info("Re-creating alarm queue ...");
            this.queue.close(() => {
              this.setupAlarmQueue().then(() => {
                if (retry) {
                  log.info("Retry creating alarm ...", alarm);
                  this.enqueueAlarm(alarm, false, profile);
                }
              });
            });
          }
        }
      })
    }
  }

  applyConfig(alarm, excludes=[]) {
    excludes.push('timeout');
    const cfg = fc.getConfig().alarms;
    const defaultCfg = fc.getDefaultConfig().alarms;
    const alarmConfig = {};
    if (defaultCfg && defaultCfg.apply) {
      Object.assign(alarmConfig, defaultCfg.apply);
    }
    if (cfg && cfg.apply) {
      Object.assign(alarmConfig, cfg.apply);
    }
    log.debug("alarm config apply", alarmConfig, alarm.type);
    const alias = Alarm.alarmType2alias(alarm.type);
    if (alarmConfig.hasOwnProperty(alias)) {
      alarm.apply(_.omit(alarmConfig[alias], excludes));
    } else if (alarmConfig.default){ // default
      alarm.apply(_.omit(alarmConfig.default, excludes));
    }
  }

  // a lite update alarm version, return modified attrs with origin value
  async _applyAlarm(alarm) {
    if (!alarm || !alarm.aid) {
      log.warn('alarm must have aid to apply changes', alarm);
      return;
    }
    const alarmKey = alarmPrefix + alarm.aid;
    const orig_alarm = await rclient.hgetallAsync(alarmKey);
    if (!orig_alarm) {
      log.warn('cannot apply alarm change, alarm not found', alarm.aid);
      return;
    }
    log.debug('apply alarm attrs', alarm, 'to', orig_alarm);
    let attrs = {state: orig_alarm.state}; // origin attrs
    if (orig_alarm.hasOwnProperty('p.msp.decision')) {
      attrs['p.msp.decision'] = orig_alarm['p.msp.decision'];
    }

    // only allow reapply state: ignore -> ready or active -> ignore
    let redecision = (orig_alarm.state == Constants.ST_ACTIVATED && alarm.state == Constants.ST_IGNORE) || ( orig_alarm.state == Constants.ST_IGNORE && alarm.state == Constants.ST_READY);
    for (const k in alarm) {
      if (alarm[k] != orig_alarm[k]) {
        attrs[k] = orig_alarm[k];
      }
      if (k == "state" && alarm[k] != Constants.ST_READY && alarm[k] != Constants.ST_IGNORE) {
        log.warn('apply alarm invalid state, skip change state', alarm);
        delete alarm[k];
        continue;
      }
      if (k == "state" && alarm[k] != orig_alarm.state && (orig_alarm.state == Constants.ST_ACTIVATED || orig_alarm.state == Constants.ST_IGNORE) && !redecision) {
        log.warn('alarm already activated or ignored, skip change state', alarm);
        delete alarm[k];
        continue
      }
    }

    try {
      alarm['applyTimestamp'] = Date.now()/1000;
      alarm['type'] = orig_alarm.type;
      await this.saveAlarm(alarm);
    } catch (err) {
      log.warn('fail to save alarm changes', alarm, err.message);
    }
    return attrs;
  }

  async _onState(alarm, options={}) {
    switch (alarm.state) {
      case Constants.ST_READY: {
        if (options.origin['p.msp.decision']) {
          options['p.msp.decision'] = options.origin['p.msp.decision'] + ',active';
        } else {
          options['p.msp.decision'] = 'active';
        }
        await this.activateAlarm(alarm, options);
        break;
      }
      case Constants.ST_IGNORE: {
        await this.mspIgnoreAlarm(alarm.aid, options)
        break;
      }
      default: {
        log.info('skip handle state change of alarm', alarm, options);
      }
    }
  }

  async onAlarmSyncEvent(alarm, attrs, options = {}) {
    if (!attrs) {
      return
    }
    for (const attr in attrs) {
      switch (attr) {
        case 'state': {
          const opt = Object.assign({}, options, {origin:attrs});
          await this._onState(alarm, opt);
          break;
        }
      }
    }
  }

  async mspSyncAlarm(cmd, alarms) {
    switch (cmd) {
      case 'apply': {
        if (_.isArray(alarms)){
          for (const alarm of alarms) {
            // update alarm simple attrs, too heavy to use updateAlarm
            const attrs = await this._applyAlarm(alarm);
            await this.onAlarmSyncEvent(alarm, attrs);
          }
        }
        break;
      }
      default:
        log.warn('cannot handle msp sync alarm command', cmd, alarms);
    }
  }

  async checkAndSave(alarm, callback) {
    callback = callback || function () { };

    try {
      let res = await this.checkAndSaveAsync(alarm);
      callback(null, res);
    }
    catch (err) {
      callback(err, null);
    }
  }

  async checkAndSaveAsync(alarm, profile) {
    const il = require('../intel/IntelLoader.js');

    alarm = await il.enrichAlarm(alarm);

    let verifyResult = this.validateAlarm(alarm);
    if (!verifyResult) {
      throw new Error("invalid alarm, failed to pass verification");
    }

    log.info("Checking if similar alarms are generated recently");
    const hasDup = await this.dedup(alarm, profile);

    if (hasDup) {
      log.warn("Skipped dup alarm", alarm.type, "dest:", alarm["p.dest.name"], alarm["p.dest.ip"],
        "src:", alarm["p.device.name"], alarm["p.device.ip"]);
      let err = new Error("duplicated with existing alarms");
      err.code = 'ERR_DUP_ALARM';
      throw err;
    }

    const matches = await exceptionManager.match(alarm);

    if (exceptionManager.isFirewallaCloud(alarm) || matches && matches.length) {
      matches.forEach((e) => {
        log.info("Matched Exception: " + e.eid);
        exceptionManager.updateMatchCount(e.eid); // async incr the match count for each matched exception
      });
      const err3 = new Error("alarm is covered by exceptions");
      err3.code = 'ERR_COVERED_BY_EXCEPTION';
      throw err3;
    }


    const devicePolicy = _.get(await alarm.getDevice(), 'policy', {})

    // don't do policy match for emergency access and customized alarm
    if ((!devicePolicy.hasOwnProperty('acl') || devicePolicy.acl === true)
      && alarm.type !== "ALARM_CUSTOMIZED"
    ) {
      const policyMatch = await pm2.match(alarm)

      if (policyMatch) {
        // already matched some policy

        const err2 = new Error("alarm is covered by policies");
        err2.code = 'ERR_BLOCKED_BY_POLICY_ALREADY';
        throw err2;
      }
    }

    const trustMatch = await tm.matchAlarm(alarm);
    if (trustMatch) {
      const trustErr = new Error("alarm is covered by trust");
      trustErr.code = 'ERR_BLOCKED_BY_TRUST_ALREADY';
      throw trustErr;
    }

    const arbitrationResult = await bone.arbitration(alarm);

    if (!arbitrationResult) {
      throw new Error("invalid alarm, failed to pass cloud verification");
    }

    alarm = this.jsonToAlarm(arbitrationResult);

    if (!alarm) {
      throw new Error("invalid alarm json from cloud");
    }

    if (alarm["p.cloud.decision"] && alarm["p.cloud.decision"] === 'ignore') {
      log.info(`Alarm is ignored by cloud: ${alarm}`);
      return 0;
    } else {
      if (alarm["p.cloud.decision"] && alarm["p.cloud.decision"] === 'block') {
        log.info(`Decision from cloud is auto-block`, alarm.type, alarm["p.device.ip"], alarm["p.dest.ip"]);
      }
    }

    // HACK, update rdns if missing, sometimes intel contains ip => domain, but rdns entry is missing
    const destName = alarm["p.dest.name"]
    const destIP = alarm["p.dest.ip"]
    if (destName && destIP && destName !== destIP) {
      dnsTool.addReverseDns(destName, [destIP])
    }

    const alarmID = await this.saveAlarm(alarm)
    await this.activateAlarm(alarm, {origin:{state: Constants.ST_INIT}});

    // invoke post alarm generated hook logic
    if (alarm.onGenerated instanceof Function) {
      alarm.onGenerated().catch((err) => {
        log.error(`Failed to invoke onGenerated hook on alarm ${alarmID}`);
      })
    }
    return alarmID
  }

  async _activateAlarm(alarm, unarchive = false) {
    let score = parseFloat(alarm.alarmTimestamp) || new Date() / 1000;
    if (unarchive) {
      await rclient.zremAsync(alarmArchiveKey, alarm.aid);
    }
    return await rclient.multi()
      .zrem(alarmPendingKey, alarm.aid)
      .zadd(alarmActiveKey, 'NX', score, alarm.aid)
      .execAsync();
  }

  async activateAlarm(alarm, options={}) {
    log.info('activate alarm', alarm, options);
    let unarchive = false;

    if (this.isAlarmSyncMspEnabled()) {
      if ((alarm.state && alarm.state == Constants.ST_ACTIVATED) || (options.origin && options.origin.state == Constants.ST_ACTIVATED)) {
        log.warn(`alarm ${alarm.aid} already activated`)
        return;
      }
      // check state
      if (alarm.state && alarm.state == Constants.ST_PENDING) {
        log.debug(`alarm ${alarm.aid} still pending`)
        return;
      }
      if (alarm.state && alarm.state == Constants.ST_READY && options.origin && options.origin.state == Constants.ST_IGNORE) {
        unarchive = true
      }
    }

    alarm.state = Constants.ST_ACTIVATED;
    const alarmKey = alarmPrefix + alarm.aid;
    let updateAttrs = ['state', Constants.ST_ACTIVATED];
    if (options['p.msp.decision']) {
      updateAttrs.push('p.msp.decision', options['p.msp.decision']);
    }
    await rclient.hmsetAsync(alarmKey, updateAttrs);

    const orig_alarm = await rclient.hgetallAsync(alarmKey);
    alarm = Object.assign({}, orig_alarm, alarm);
    const result  = await this._activateAlarm(alarm, unarchive);
    pclient.publishAsync("alarm:updateCache", JSON.stringify({aid:alarm.aid}));

    // check alarm state change results
    if (this.isAlarmSyncMspEnabled() && result.length >= 2) {
      if (result[0] != 1 && !(options.origin && options.origin.state == Constants.ST_INIT)) {
        log.warn('error remove alarm from pending queue', alarm.aid, result[0]);
      }
      if (result[1] != 1) {
        log.warn('error add alarm to active queue', alarm.aid, result[1]);
      }
    }
    // record security alarm count on hostInfo
    if (alarm['p.device.mac'] && Alarm.isSecurityAlarm(alarm.type)) {
      const mac = alarm['p.device.mac'].toUpperCase();
      if (hostTool.isMacAddress(mac)) {
        const macKey = hostTool.getMacKey(mac);
        try {
          const keyExists = await rclient.existsAsync(macKey);
          if (keyExists == 1)
            await rclient.hincrbyAsync(macKey, 'security_alarm', 1)
        } catch (err) {
          log.warn(`Failed to count security alarm ${alarm['p.device.mac']}`, err);
        }
      }
    }

    try {
      log.info("AlarmManager:Check:AutoBlock", alarm.aid);
      const ret = await this.shouldAutoBlock(alarm);
      if (fConfig && fConfig.policy &&
        fConfig.policy.autoBlock &&
        fc.isFeatureOn("cyber_security.autoBlock") && ret
      ) {

        // auto block if num is greater than the threshold
        await this.blockFromAlarmAsync(alarm.aid, {
          method: "auto",
          info: {
            category: alarm["p.dest.category"] || "",
            method: "auto"
          }
        })

        // if = intel feedback
        if (alarm['p.dest.ip']) {
          alarm["if.target"] = alarm['p.dest.ip'];
          alarm["if.type"] = "ip";
          bone.submitIntelFeedback("autoblock", alarm);
        }
      }

    } catch (err) {
      log.error('Failed on alarm autoblock', err)
    } finally {
      this.notifAlarm(alarm.aid);
    }
  }

  _genAlarm(a = {}) {
    let proto = Alarm.mapping[Alarm.alias2alarmType(a.type)];
    if (!proto) {
      return null
    }
    let alarm;
    let ts = a.timestamp || Date.now()/1000;
    // Outbound constructors
    if (proto instanceof Alarm.OutboundAlarm) {
      alarm = new proto.constructor(ts, a.device, a['p.dest.id'], _.omit(a, ['type', 'device', 'p.dest.id']));
    } else {
      switch (proto.constructor.name) {
        case 'VulnerabilityAlarm':{
          alarm = new proto.constructor(ts, a.device, a['p.vid'], _.omit(a, ['type', 'device', 'p.vid']));
          break;
        }
        case 'BroNoticeAlarm': {
          alarm = new proto.constructor(ts, a.device, a['p.noticeType'], a['p.message'], _.omit(a, ['type', 'device', 'p.noticeType', 'p.message']));
          break;
        }
        case 'IntelAlarm': {
          alarm = new proto.constructor(ts, a.device, a['p.severity'],  _.omit(a, ['type', 'device', 'p.severity']));
          break;
        }
        default: {
          alarm = new proto.constructor(ts, a.device, _.omit(a, ['type', 'device']));
          break;
        }
      }
    }
    if (alarm["p.msp.ready"]) {
      alarm.state = Constants.ST_READY;
      alarm["p.msp.decision"] = "create"
    }
    log.debug('alarm generated', alarm);
    return alarm;
  }

  async shouldAutoBlock(alarm) {
    if (!fConfig || !fConfig.policy ||
      !fConfig.policy.autoBlock ||
      !fc.isFeatureOn("cyber_security.autoBlock"))
      return false;

    const ip = alarm["p.dest.ip"];
    let ret;
    if (ip) ret = await intelTool.unblockExists(ip);
    if (ret) return false;
    
    const domain = alarm["p.dest.name"];
    ret = domain && await intelTool.unblockExists(domain);
    if (ret) return false;

    if (alarm && alarm.type === 'ALARM_NEW_DEVICE' &&
      fc.isFeatureOn("new_device_block")) {
      return true;
    }

    if (alarm["p.cloud.decision"] === "block" ||
      alarm["p.action.block"] === "true" || alarm["p.action.block"] === true) {
      return true
    }

    return false;
  }

  jsonToAlarm(json) {
    if (!json)
      return null;

    let proto = Alarm.mapping[json.type];
    if (proto) {
      let obj = Object.assign(Object.create(proto), json);
      obj.message = obj.localizedMessage(); // append locaized message info
      if (obj["p.flow"]) {
        delete obj["p.flow"];
      }

      for (const key of Object.keys(obj)) {
        const value = obj[key];
        // try to convert string of JSON object/array to JSON format
        if (_.isString(value) && (validator.isJSON(value) || value === "undefined")) {
          try {
            if (value === "undefined")
              delete obj[key];
            else
              obj[key] = JSON.parse(value);
          } catch (err) { log.warn("fail to convert to alarm, key", key, err.message) }
        }
      }
      return obj;
    } else {
      log.error(`Unsupported alarm type ${json.type} alarm ${json.aid}`);
      return null;
    }
  }

  async getAlarm(alarmID) {
    const results = await this.idsToAlarmsAsync([alarmID])
    if (results == null || results.length === 0) {
      throw new Error("alarm not exists");
    }

    return results[0];
  }

  async idsToAlarmsAsync(ids) {
    if (!Array.isArray(ids)) throw new Error('Non-array ID input')

    let multi = rclient.multi();

    ids.forEach((aid) => {
      multi.hgetall(alarmPrefix + aid);
    });

    const results = await multi.execAsync()

    // don't filter result and keep the original id to alarm mapping
    return results.map((r) => this.jsonToAlarm(r))
  }

  idsToAlarms(ids, callback = function () { }) {
    return util.callbackify(this.idsToAlarmsAsync).bind(this)(ids, callback)
  }

  // This function will only return when there is new alarm data or timeout
  async fetchNewAlarms(sinceTS, { timeout }) {
    const alarms = await this.loadAlarmsByTimestamp(sinceTS);
    timeout = timeout || 60;

    if (alarms.length > 0) {
      return alarms;
    }

    // wait for new alarm coming or timeout
    const result = await Promise.race([
      delay(timeout * 1000),
      this.newAlarmEvent()
    ]);

    if (result) {
      return [result];
    } else {
      return [];
    }
  }

  async newAlarmEvent() {
    return new Promise((resolve, reject) => {
      sem.once("Alarm:NewAlarm", (event) => {
        this.getAlarm(event.alarmID).then(resolve, reject);
      });
    });
  }

  async loadAlarmsByTimestamp(sinceTS) {
    sinceTS = sinceTS || 0;

    // zrevrangebyscore alarm_active 1544164497 0 withscores limit 0 10
    // use ( to exclude sinceTS itself
    const alarmIDs = await rclient.zrevrangebyscoreAsync(alarmActiveKey, new Date() / 1000, `(${sinceTS}`);

    let alarms = await this.idsToAlarmsAsync(alarmIDs);

    alarms = alarms.filter((a) => a != null);

    return alarms;
  }

  async loadRecentAlarmsAsync(duration) {
    duration = duration || 10 * 60;

    let scoreMax = new Date() / 1000 + 1;
    let scoreMin;
    if (duration == "-inf") {
      scoreMin = "-inf";
    } else {
      scoreMin = scoreMax - duration;
    }

    let recentResults = [];
    let alarmIDs, results;

    try {
      alarmIDs = await rclient.zrevrangebyscoreAsync(alarmPendingKey, scoreMax, scoreMin);
      results = await this.idsToAlarmsAsync(alarmIDs);
      if (results) {
        results = results.filter((a) => a != null);
        recentResults = recentResults.concat(results);
      }
    } catch (err) {
      log.warn("cannot get pending alarms", err.message);
    }

    try {
      alarmIDs = await rclient.zrevrangebyscoreAsync(alarmActiveKey, scoreMax, scoreMin);
      results = await this.idsToAlarmsAsync(alarmIDs);
      if (results) {
        results = results.filter((a) => a != null);
        recentResults = recentResults.concat(results);
      }
    } catch (err) {
      log.warn("cannot get active alarms", err.message);
    }
    return recentResults;
  }

  async loadPendingAlarms(options) {
    const offset = options && options.offset || 0 // default starts from 0
    const limit = options && options.limit || 50 // default load 50 alarms
    let alarmIDs = await rclient.zrevrangebyscoreAsync(alarmPendingKey,
        "+inf", "-inf", "limit", offset, limit);
    let alarms = await this.idsToAlarmsAsync(alarmIDs);
    return alarms.filter((a) => a != null)
  }

  async loadArchivedAlarms(options) {
    options = options || {}

    const offset = options.offset || 0 // default starts from 0
    const limit = options.limit || 50 // default load 50 alarms

    let alarmIDs = await rclient.
      zrevrangebyscoreAsync(alarmArchiveKey,
        "+inf",
        "-inf",
        "limit",
        offset,
        limit);

    let alarms = await this.idsToAlarmsAsync(alarmIDs);

    alarms = alarms.filter((a) => a != null)

    return alarms
  }

  async archiveAlarm(alarmID) {
    const result = await rclient.multi()
      .zrem(alarmActiveKey, alarmID)
      .zadd(alarmArchiveKey, 'nx', new Date() / 1000, alarmID)
      .execAsync();
    pclient.publishAsync("alarm:updateCache", JSON.stringify({aid:alarmID}));
    return result;
  }

  async archiveAlarmByExceptionAsync(exceptionID) {
    const exception = await exceptionManager.getException(exceptionID);
    const alarms = await this.findSimilarAlarmsByException(exception);
    for (const alarm of alarms) {
      alarm.result_exception = exception.eid;
      alarm.result = "archiveByException";
      await this.updateAlarm(alarm);
      await this.archiveAlarm(alarm.aid);
    }
    return alarms;
  }

  async listExtendedAlarms() {
    const list = await rclient.scanResults(`${alarmDetailPrefix}:*`);

    return list.map(l => l.substring(alarmDetailPrefix.length + 1))
  }

  async listBasicAlarms() {
    const list = await rclient.scanResults(`_alarm:*`);

    return list.map(l => l.substring(7))
  }

  async deleteExtendedAlarm(alarmID) {
    await rclient.unlinkAsync(`${alarmDetailPrefix}:${alarmID}`);
  }

  numberOfAlarms(callback) {
    callback = callback || function () { }

    rclient.zcount(alarmActiveKey, "-inf", "+inf", (err, result) => {
      if (err) {
        callback(err);
        return;
      }

      // TODO: support more than 20 in the future
      callback(null, result > 20 ? 20 : result);
    });
  }

  async numberOfArchivedAlarms() {
    const count = await rclient.zcountAsync(alarmArchiveKey, "-inf", "+inf");
    return count;
  }

  async getActiveAlarmCount() {
    return rclient.zcountAsync(alarmActiveKey, '-inf', '+inf');
  }

  async getPendingAlarmCount() {
    return await rclient.zcountAsync(alarmPendingKey, '-inf', '+inf');
  }

  async loadAlarmIDs() {
    const activeAlarmIDs = await rclient.zrangeAsync(alarmActiveKey, 0, -1);
    const archivedAlarmIDs = await rclient.zrangeAsync(alarmArchiveKey, 0, -1);
    const pendingAlarmIDs = await rclient.zrangeAsync(alarmPendingKey, 0, -1);
    return {
      activeAlarmIDs, archivedAlarmIDs, pendingAlarmIDs
    }
  }

  // ** lagacy prototype loadActiveAlarms(count, callback)
  //
  // options:
  //  count: number of alarms returned, default 50
  //  ts: timestamp used to query alarms, default to now
  //  asc: return results in ascending order, default to false
  loadActiveAlarms(options, callback) {
    if (_.isFunction(options)) {
      callback = options;
    }
    callback = callback || function () { }

    this.loadActiveAlarmsAsync(options)
      .then(res => callback(null, res))
      .catch(err => {
        log.error("Failed to load active alarms: " + err);
        callback(err)
      })
  }

  async loadAlarmsWithRange(options) {
    options = options || {};
    let { begin, end, count, offset, type } = options;
    end = end || Date.now() / 1000;
    count = count || 1000;
    offset = offset || 0;
    type = type || 'all';
    let activeAlarms = [], archivedAlarms = [];
    if (type == 'all' || type == 'active') {
      const activeAlarmsQuery = rclient.zrevrangebyscoreAsync(alarmActiveKey, '(' + end, begin ? begin + ')' : '-inf', 'limit', offset, count);
      activeAlarms = await this.idsToAlarmsAsync(await activeAlarmsQuery);
      activeAlarms = activeAlarms.filter(a => a != null);
    }
    if (type == 'all' || type == 'archived') {
      const archivedAlarmsQuery = rclient.zrevrangebyscoreAsync(alarmArchiveKey, '(' + end, begin ? begin + ')' : '-inf', 'limit', offset, count, 'withscores');
      const archivedAlarmIdsWithScores = await archivedAlarmsQuery;
      let archivedAlarmIds = []
      let idScoreMap = {};
      for (let i = 0; i < archivedAlarmIdsWithScores.length; i++) {
        if (i % 2 === 1) {
          const id = archivedAlarmIdsWithScores[i - 1]
          const score = Number(archivedAlarmIdsWithScores[i])
          idScoreMap[id] = score
          archivedAlarmIds.push(id)
        }
      }
      archivedAlarms = await this.idsToAlarmsAsync(archivedAlarmIds);
      archivedAlarms = archivedAlarms.filter(a => a != null)
      archivedAlarms.map((a) => { a['action.time'] = idScoreMap[a.aid] })
    }
    return { activeAlarms: activeAlarms, archivedAlarms: archivedAlarms }
  }

  _filterQueryType(alarm, type) {
    switch (type) {
      case 'active':
        return alarm.state == type && alarm.archived != 1;
      case 'pending':
      case 'ignore':
        return alarm.state == type;
      default:
        return alarm.state == 'active' && alarm.archived == 1;
    }
  }

  _queryCachedAlarmIds(count, ts, asc, type, filters) {
    let ids = [];
    if (filters && filters.types && _.isArray(filters.types)) {
      for (const atype of filters.types) {
        if (!this.indexCache.has(atype)) continue;
        const entries = Object.values(this.indexCache.get(atype));
        if (entries.length == 0) continue;
        let tmp = entries.filter(i => this._filterQueryType(i, type)).filter(i=>{if (asc) return i.ts > ts; return i.ts < ts});
        if (asc) tmp = tmp.reverse();
        ids = ids.concat(tmp.map( (i) => {return {aid: i.aid, ts: i.ts}}));
      }
    }
    ids.sort( (x,y) => {if (asc) return x.ts - y.ts; return y.ts - x.ts});
    return ids.map(i => i.aid).slice(0, count);
  }

  async loadActiveAlarmsAsync(options) {
    let count, ts, asc, type, filters;

    if (_.isNumber(options)) {
      count = options;
    } else if (options) {
      ({ count, ts, asc, type, filters } = options);
    }

    count = count || 50;
    ts = ts || Date.now() / 1000;
    asc = asc || false;
    type = type || 'active';

    let ids;
    if (filters && this.indexCache._disabled != 1 && !await this._fallbackAlarmCache(filters.types)) {
      log.debug("query from cache, cached keys", this.indexCache.keys());
      ids = this._queryCachedAlarmIds(count, ts, asc, type, filters);
    } else {
      log.debug(`query from redis, cache fallback ${this.indexCache.keys()} disabled ${this.indexCache._disabled}` );
      let key = type == 'active' ? alarmActiveKey : alarmArchiveKey;
      let query = asc ?
        rclient.zrangebyscoreAsync(key, '(' + ts, '+inf', 'limit', 0, count) :
        rclient.zrevrangebyscoreAsync(key, '(' + ts, '-inf', 'limit', 0, count);
      ids = await query;
    }

    let alarms = await this.idsToAlarmsAsync(ids)

    return alarms.filter(Boolean)
  }

  async getAlarmDetail(aid) {
    const key = `${alarmDetailPrefix}:${aid}`
    const detail = await rclient.hgetallAsync(key);
    if (detail) {
      for (let key in detail) {
        if (key.startsWith("r.")) {
          delete detail[key];
        }
      }
    }

    return detail;
  }

  // parseDomain(alarm) {
  //   if(!alarm["p.dest.name"] ||
  //      alarm["p.dest.name"] === alarm["p.dest.ip"]) {
  //     return null // not support ip only alarm
  //   }

  //   let fullName = alarm["p.dest.name"]

  //   let items = fullName.split(".")



  // }

  async findSimilarAlarmsByPolicy(policy) {
    let alarms = await this.loadActiveAlarmsAsync(200); // load 200 alarms for comparison
    return alarms.filter((alarm) => {
      if (alarm.result && alarm.result !== "") {
        return false
      }

      if (policy.match(alarm)) {
        return true
      } else {
        return false
      }
    })
  }

  async blockAlarmByPolicy(alarm, policy, info) {
    if (!alarm || !policy) {
      return
    }

    log.info(`Alarm to block: ${alarm.aid}`)

    alarm.result_policy = policy.pid;
    alarm.result = "block";

    if (info && info.method === "auto") {
      alarm.result_method = "auto";
    }

    await this.updateAlarm(alarm);

    await this.archiveAlarm(alarm.aid);

    log.info(`Alarm ${alarm.aid} is blocked successfully`)
  }

  async findSimilarAlarmsByException(exception, curAlarmID) {
    let alarms = await this.loadActiveAlarmsAsync(200);
    return alarms.filter((alarm) => {
      if (alarm.aid === curAlarmID) {
        return false // ignore current alarm id, since it's already blocked
      }

      if (alarm.result && alarm.result !== "") {
        return false
      }

      if (exception.match(alarm)) {
        return true
      } else {
        return false
      }
    })
  }

  async allowAlarmByException(alarm, exception, info, needArchive) {
    if (!alarm || !exception) {
      return
    }

    log.info(`Alarm to allow: ${alarm.aid}`)

    alarm.result_exception = exception.eid;
    alarm.result = "allow";

    if (info.method === "auto") {
      alarm.result_method = "auto";
    }

    await this.updateAlarm(alarm);

    if (needArchive) {
      await this.archiveAlarm(alarm.aid);
    } else {
      await this.removeAlarmAsync(alarm.aid);
    }

    log.info(`Alarm ${alarm.aid} is allowed successfully`)
  }

  blockFromAlarm(alarmID, info, callback) {
    return util.callbackify(this.blockFromAlarmAsync).bind(this)(alarmID, info, callback || function () { })
  }

  async blockFromAlarmAsync(alarmID, value) {
    log.info("Going to block alarm " + alarmID);
    log.info("value: ", value);

    let info = value.info;

    const alarm = await this.getAlarm(alarmID)

    log.info("Alarm to block:", alarm);

    if (!alarm) {
      log.error("Invalid alarm ID:", alarmID);
      throw new Error("Invalid alarm ID: " + alarmID);
    }

    let p = {
      alarm_type: alarm.type,
      aid: alarmID,
      reason: alarm.type,
    };

    if (alarm["p.blockby"] == 'fastdns') {
      p.blockby = 'fastdns';

      // use dns block for active protect
      p.dnsmasq_only = true;
    }

    //BLOCK
    switch (alarm.type) {
      case "ALARM_NEW_DEVICE":
      case "ALARM_DEVICE_OFFLINE":
      case "ALARM_DEVICE_BACK_ONLINE":
      case "ALARM_ABNORMAL_BANDWIDTH_USAGE":
        p.type = "mac";
        p.target = alarm["p.device.mac"];
        break;

      // case "ALARM_BRO_NOTICE":
      //   const {type, target} = require('../extension/bro/BroNotice.js').getBlockTarget(alarm);
      //
      //   if(type && target) {
      //     p.type = type;
      //     p.target = target;
      //   } else {
      //     log.error("Unsupported alarm type for blocking: ", alarm)
      //     throw new Error("Unsupported alarm type for blocking: " + alarm.type)
      //   }
      //   break;

      case "ALARM_UPNP": {
        p.type = "mac"

        let targetMac = alarm["p.device.mac"];

        // policy should be created with mac
        if (!targetMac) {
          let targetIp = alarm["p.device.ip"];

          dnsManager.resolveLocalHost(targetIp, (err, result) => {
            if (err || result == null) {
              log.error("Alarm doesn't have mac and unable to resolve ip:", targetIp, err);
              throw new Error("Alarm doesn't have mac and unable to resolve ip:", targetIp);
            }

            targetMac = result.mac;
          })
        }

        p.localPort = alarm["p.upnp.private.port"];
        p.protocol = alarm["p.upnp.protocol"];
        p.target = targetMac;
        p.direction = "inbound";

        p.flowDescription = alarm.message;

        break;
      }

      default:

        if (alarm["p.dest.name"] === alarm["p.dest.ip"]) {
          p.type = "ip";
          p.target = alarm["p.dest.ip"];
        } else {
          p.type = "dns";
          p.target = alarm["p.dest.name"];
        }

        if (info) {
          switch (info.type) {
            case "dns":
            case "domain":
              p.type = "dns"
              p.target = info.target
              break
            case "ip":
              p.type = "ip"
              p.target = info.target
              break
            case "category":
              p.type = "category";
              p.target = info.target;
              break;
            case "devicePort":
              p.type = info.type;
              p.target = info.target;
              break;
            case "country":
              p.type = info.type;
              p.target = info.target;
              break;
            case "mac":
            case "internet":
              if (alarm["p.device.mac"]) {
                p.type = info.type;
                p.target = "TAG";
                p.scope = [alarm["p.device.mac"]]; // by default block internet from alarm will be applied to device level, this will be changed if info.tag or info.intf is set
              }
            default:
              break
          }
          const additionalPolicyKeys = ["direction", "action", "localPort", "remotePort", "dnsmasq_only", "protocol"];
          for (const key of additionalPolicyKeys) {
            if (info.hasOwnProperty(key))
              p[key] = info[key];
          }
        }
        break;
    }

    if (!p.type || !p.target) {
      throw new Error("Unsupported Action!")
    }

    p["if.type"] = p.type;
    p["if.target"] = p.target;

    if (value.method) {
      p.method = value.method;
    }

    if (info) {
      if (info.type === 'dns' && info.exactMatch == true) {
        p.domainExactMatch = "1";
      }

      if (info.method) {
        p.method = info.method;
      }

      if (info.device) {
        p.scope = [info.device];
      }

      p.tag = [];
      if (info.intf) {
        p.tag.push(Policy.INTF_PREFIX + info.intf); // or use tag array
        if (p.scope && !info.device)
          delete p.scope;
        if (p.type === "mac" && hostTool.isMacAddress(p.target))
          delete p.target;
      }

      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        const prefix = config.ruleTagPrefix.substring(0, config.ruleTagPrefix.length - 1); // strip last colon, e.g., tag:
        if (_.has(info, prefix)) {
          p.tag.push(`${config.ruleTagPrefix}${info[prefix]}`);
          if (p.scope && !info.device)
            delete p.scope;
        }
      }

      if (info.matchAllDevice) {
        if (p.scope)
          delete p.scope;
        if (p.type === "mac" && hostTool.isMacAddress(p.target))
          p.target = "TAG";
      }

      if (info.category) {
        p.category = info.category
      } else {
        p.category = ""
      }

      if (info.app) {
        p.matchAppId = info.app;
      }

      if (_.isObject(info.customizedKeys)) {
        for (const key of Object.keys(info.customizedKeys))
          p[key] = info.customizedKeys[key];
      }

    } else {
      if (p.type === 'dns') {
        p.domainExactMatch = "1"; // by default enable domain exact match
      }
    }

    // add additional info
    // TODO: we will want to obsolete target_name & target_ip on android app
    switch (p.type) {
      case "mac":
        p.target_name = alarm["p.device.name"] || alarm["p.device.ip"];
        p.target_ip = alarm["p.device.ip"];
        break;
      case "ip":
        p.target_name = alarm["p.dest.name"] || alarm["p.dest.ip"];
        p.target_ip = alarm["p.dest.ip"];
        break;
      case "dns":
        p.target_name = alarm["p.dest.name"] || alarm["p.dest.ip"];
        p.target_ip = alarm["p.dest.ip"];
        break;
      case "category":
        p.target_name = alarm["p.dest.category"];
        p.target_ip = alarm["p.dest.ip"];
        break;
      default:
        break;
    }

    // record the direction of the trigger flow when block is created from alarm.
    if ("p.local_is_client" in alarm) {
      if (Number(alarm["p.local_is_client"]) === 1) {
        p.fd = "in";
      } else if (Number(alarm["p.local_is_client"]) === 0) {
        p.fd = "out";
      }
    }

    p = new Policy(p);

    log.info("Policy object:", p);

    // FIXME: make it transactional
    // set alarm handle result + add policy
    const { policy, alreadyExists } = await pm2.checkAndSaveAsync(p)
    alarm.result_policy = policy.pid;
    alarm.result = "block";

    if (value.method === "auto") {
      alarm.result_method = "auto";
    }

    await this.updateAlarm(alarm)

    if (alarm.result_method != "auto") {
      // archive alarm unless it's auto block
      await this.archiveAlarm(alarm.aid)
    }

    log.info("Trying to find if any other active alarms are covered by this new policy")
    const alarms = await this.findSimilarAlarmsByPolicy(p)
    const blockedAlarms = []
    for (const a of alarms) {
      if (a.aid == alarm.aid) continue
      try {
        await this.blockAlarmByPolicy(a, policy, info)
        blockedAlarms.push(a)
      } catch (err) {
        log.error(`Failed to block alarm ${a.aid} with policy ${policy.pid}: ${err}`)
      }
    }
    return { policy, blockedAlarms, alreadyExists }
  }

  async allowFromAlarm(alarmID, info) {
    log.info("Going to allow alarm " + alarmID);

    let userInput = info.info;

    const alarm = await this.getAlarm(alarmID)

    log.info("Alarm to allow: ", alarm);

    if (!alarm) {
      log.error("Invalid alarm ID:", alarmID);
      throw new Error("Invalid alarm ID: " + alarmID)
    }

    const e = this.createException(alarm, userInput);

    // FIXME: make it transactional
    // set alarm handle result + add policy

    const { exception, alreadyExists } = await exceptionManager.checkAndSave(e)

    alarm.result_exception = exception.eid;
    alarm.result = "allow";

    await this.updateAlarm(alarm)
    await this.archiveAlarm(alarm.aid)
    log.info("Trying to find if any other active alarms are covered by this new exception")
    let alarms = await this.findSimilarAlarmsByException(exception, alarm.aid)
    if (alarms && alarms.length > 0) {
      let allowedAlarms = []
      for (const alarm of alarms) {
        try {
          await this.allowAlarmByException(alarm, exception, info, true);
          allowedAlarms.push(alarm)
        } catch (err) {
          log.error(`Failed to allow alarm ${alarm.aid} with exception ${exception.eid}: ${err}`)
        }
      }
      return { exception, allowedAlarms, alreadyExists }
    } else {
      log.info("No similar alarms are found")
      return { exception, alreadyExists }
    }
  }

  unblockFromAlarm(alarmID, info, callback) {
    this.unblockFromAlarmAsync(alarmID, info).then(
      res => callback(null, res),
      err => callback(err, null)
    )
  }

  async unblockFromAlarmAsync(alarmID, info) {
    log.info("Going to unblock alarm " + alarmID);

    let alarmInfo = info.info; // not used by now

    let alarm = await this.getAlarm(alarmID)

    if (!alarm) {
      log.error("Invalid alarm ID:", alarmID);
      throw new Error("Invalid alarm ID: " + alarmID);
    }

    let pid = alarm.result_policy;

    // FIXME: make it transactional
    // set alarm handle result + add policy

    await pm2.disableAndDeletePolicy(pid)

    alarm.result = "";
    alarm.result_policy = "";
    alarm.result_method = "";
    await this.updateAlarm(alarm)
  }

  unallowFromAlarm(alarmID, info, callback) {
    this.unallowFromAlarmAsync(alarmID, info).then(
      res => callback(null, res),
      err => callback(err, null)
    )
  }

  async unallowFromAlarmAsync(alarmID, info) {
    log.info("Going to unallow alarm " + alarmID);

    let alarmInfo = info.info; // not used by now

    let alarm = await this.getAlarm(alarmID)

    if (!alarm) {
      log.error("Invalid alarm ID:", alarmID);
      throw new Error("Invalid alarm ID: " + alarmID);
    }

    let eid = alarm.result_exception;

    // FIXME: make it transactional
    // set alarm handle result + add policy

    await exceptionManager.deleteException(eid);
    alarm.result = "";
    alarm.result_policy = "";
    await this.updateAlarm(alarm);
  }

  async _alignAlarmInfo(alarm) { // alarm object
    if (!alarm.hasOwnProperty("p.device.ip") && alarm["p.device.mac"]) {
      const device = await dnsManager.resolveMac(alarm['p.device.mac'].toUpperCase());
      if (device) {
        alarm["p.device.ip"] = device.ipv4 || device.ipv4Addr || JSON.parse(device.ipv6Addr || '[]').pop() || '';
      }
    }
    if (!alarm.hasOwnProperty("p.dest.name") && alarm["p.dest.ip"]) {
      alarm["p.dest.name"] = await dnsTool.getDns(alarm["p.dest.ip"]);
    }
    return alarm
  }

  async enrichDeviceInfo(alarm) {
    const ignoreAlarmTypes = ['ALARM_SCREEN_TIME', 'ALARM_DUAL_WAN'];
    if (ignoreAlarmTypes.includes(alarm.type)) return alarm;
    let deviceIP = alarm["p.device.ip"];
    if (!deviceIP) {
      throw new Error("requiring p.device.ip");
    }

    if (deviceIP === "0.0.0.0") {
      // do nothing for 0.0.0.0
      Object.assign(alarm, {
        "p.device.name": "0.0.0.0",
        "p.device.id": "0.0.0.0",
        "p.device.mac": "00:00:00:00:00:00",
        "p.device.macVendor": "Unknown"
      });

      return alarm;
    }

    // resolveLocalHost gets all info from redis, doesn't really use DNS on the fly
    const host = await dnsManager.resolveLocalHostAsync(deviceIP)

    if (host == null) {
      log.error("Failed to find host " + deviceIP + " in database");
      throw new Error("host " + deviceIP + " not found");
    }

    let deviceName = getPreferredName(host);
    let deviceID = host.mac;

    Object.assign(alarm, {
      "p.device.name": deviceName,
      "p.device.id": deviceID,
      "p.device.mac": deviceID,
      "p.device.macVendor": host.macVendor || "Unknown",
    });

    if (!alarm["p.device.real.ip"] && !hostTool.isMacAddress(deviceID)) {
      const identity = IdentityManager.getIdentityByIP(deviceIP);
      let guid;
      let realLocal;
      if (identity) {
        guid = IdentityManager.getGUID(identity);
        realLocal = IdentityManager.getEndpointByIP(deviceIP);
        alarm[identity.constructor.getKeyOfUIDInAlarm()] = identity.getUniqueId();
        alarm["p.device.guid"] = guid;
      }
      if (realLocal) {
        alarm["p.device.real.ip"] = realLocal;
      }
    }
    let realIP = alarm["p.device.real.ip"];
    if (realIP) {
      realIP = realIP.startsWith("[") && realIP.includes("]:") ? realIP.substring(1, realIP.indexOf("]:")) : realIP.split(":")[0];
      const whoisInfo = await intelManager.whois(realIP).catch((err) => { });
      if (whoisInfo) {
        if (whoisInfo.netRange) {
          alarm["e.device.ip.range"] = whoisInfo.netRange;
        }

        if (whoisInfo.cidr) {
          alarm["e.device.ip.cidr"] = whoisInfo.cidr;
        }

        if (whoisInfo.orgName) {
          alarm["e.device.ip.org"] = whoisInfo.orgName;
        }

        if (whoisInfo.country) {
          if (Array.isArray(whoisInfo.country)) {
            alarm["e.device.ip.country"] = whoisInfo.country[0];
          } else {
            alarm["e.device.ip.country"] = whoisInfo.country;
          }
        }

        if (whoisInfo.city) {
          alarm["e.dest.ip.city"] = whoisInfo.city;
        }
      }
      // intel
      const intel = await intelTool.getIntel(realIP)
      if (intel && intel.app) {
        alarm["p.device.app"] = intel.app
      }
      if (intel && intel.category) {
        alarm["p.device.category"] = intel.category;
      }

      // location
      if (intel && intel.country)
        alarm["p.device.country"] = intel.country;

      if (intel && intel.latitude && intel.longitude) {
        alarm["p.device.latitude"] = parseFloat(intel.latitude)
        alarm["p.device.longitude"] = parseFloat(intel.longitude)
      } else {
        const loc = await intelManager.ipinfo(realIP)
        if (loc && loc.loc) {
          const ll = loc.loc.split(",");
          if (ll.length === 2) {
            alarm["p.device.latitude"] = parseFloat(ll[0]);
            alarm["p.device.longitude"] = parseFloat(ll[1]);
          }
          if (loc.country)
            alarm["p.device.country"] = loc.country;
        }
      }

    }

    return alarm;
  }

  async loadRelatedAlarms(alarm, userInput) {
    const alarms = await this.loadRecentAlarmsAsync("-inf");
    const e = this.createException(alarm, userInput);
    if (!e) throw new Error("Unsupported Action!");
    const related = alarms
      .filter(relatedAlarm => e.match(relatedAlarm)).map(alarm => alarm.aid);
    return related || []
  }

  async ignoreAllAlarmAsync() {
    const alarmIDs = await rclient.zrangeAsync(alarmActiveKey, 0, -1);
    let multi = rclient.multi();
    for (const alarmID of alarmIDs) {
      log.info("ignore alarm_id:" + alarmID);
      multi.zrem(alarmActiveKey, alarmID);
      multi.zadd(alarmArchiveKey, 'nx', new Date() / 1000, alarmID);
    }
    await multi.execAsync();
    pclient.publishAsync("alarm:updateCache", JSON.stringify({aids:alarmIDs}));
    return alarmIDs;
  }

  async deleteActiveAllAsync() {
    const alarmIDs = await rclient.zrangeAsync(alarmActiveKey, 0, -1);
    let multi = rclient.multi();
    for (const alarmID of alarmIDs) {
      log.info("delete active alarm_id:" + alarmID);
      multi.zrem(alarmActiveKey, alarmID);
      multi.unlink(`${alarmDetailPrefix}:${alarmID}`);
      multi.unlink(alarmPrefix + alarmID);
    }
    await multi.execAsync();
    pclient.publishAsync("alarm:removeCache", JSON.stringify({aids:alarmIDs}));
    return alarmIDs;
  }

  async deleteArchivedAllAsync() {
    const alarmIDs = await rclient.zrangeAsync(alarmArchiveKey, 0, -1);
    let multi = rclient.multi();
    for (const alarmID of alarmIDs) {
      log.info("delete archive alarm_id:" + alarmID);
      multi.zrem(alarmArchiveKey, alarmID);
      multi.unlink(`${alarmDetailPrefix}:${alarmID}`);
      multi.unlink(alarmPrefix + alarmID);
    }
    await multi.execAsync();

    pclient.publishAsync("alarm:removeCache", JSON.stringify({aids:alarmIDs}));
    return alarmIDs;
  }

  createException(alarm, userInput) {
    let i_target = null;
    let i_type = null;
    //IGNORE
    switch (alarm.type) {
      case "ALARM_NEW_DEVICE":
      case "ALARM_DEVICE_OFFLINE":
      case "ALARM_DEVICE_BACK_ONLINE":
      case "ALARM_ABNORMAL_BANDWIDTH_USAGE":
        i_type = "mac"; // place holder, not going to be matched by any alarm/policy
        i_target = alarm["p.device.mac"];
        break;
      case "ALARM_UPNP":
        i_type = "devicePort";
        if (userInput) {
          switch (userInput.type) {
            case "deviceAllPorts":
              i_type = "deviceAllPorts";
              break;
            case "deviceAppPort":
              i_type = "deviceAppPort";
              break;
            default:
              // do nothing
              break;
          }
        }
        // policy should be created with mac
        if (alarm["p.device.mac"]) {
          i_target = util.format("%s:%s:%s",
            alarm["p.device.mac"],
            alarm["p.upnp.private.port"],
            alarm["p.upnp.protocol"]
          )
        } else {
          let targetIp = alarm["p.device.ip"];
          dnsManager.resolveLocalHost(targetIp, (err, result) => {
            if (err || result == null) {
              log.error("Alarm doesn't have mac and unable to resolve ip:", targetIp, err);
              throw new Error("Alarm doesn't have mac and unable to resolve ip:", targetIp);
            }
            i_target = util.format("%s:%s:%s",
              result.mac,
              alarm["p.upnp.private.port"],
              alarm["p.upnp.protocol"]
            )
          })
        }
        break;
      case "ALARM_BRO_NOTICE":
        // these are just a place holder to workaround the current logic
        // we probably need to deprecate the i_type & i_target check later in this function
        // as well as if.type and if.target in exception
        i_type = 'broNotice'
        i_target = userInput.target || 'ALARM_BRO_NOTICE'
        break;
      default:
        if (alarm["p.dest.name"] === alarm["p.dest.ip"]) {
          i_type = "ip";
          i_target = alarm["p.dest.ip"];
        } else {
          i_type = "dns";
          i_target = alarm["p.dest.name"];
        }
        if (userInput) {
          switch (userInput.type) {
            case "domain":
            case "dns":
              i_type = "dns"
              i_target = userInput.target
              break
            case "ip":
              i_type = "ip"
              i_target = userInput.target
              break
            case "category":
              i_type = "category";
              i_target = userInput.target;
              break;
            case "country":
              i_type = "country";
              i_target = userInput.target;
              break;
            case "ipOrg":
            case "sslO":
            case "domainRegister":
              i_type = userInput.type;
              i_target = userInput.target;
              break;
            default:
              break
          }
        }
        break;
    }
    if (userInput && userInput.archiveAlarmByType) {
      //user can archive all alarms for a specific type
      //eg: archive all ALARM_DEVICE_OFFLINE alarms
      //only match alarm type, ignore p.device.mac,p.dest.ip, etc
      i_type = alarm.type;
      i_target = alarm.type;
    }
    if (!i_type || !i_target) {
      throw new Error("Unsupported Action!")
    }
    // TODO: may need to define exception at more fine grain level
    let e = new Exception({
      type: alarm.type,
      alarm_type: alarm.type,
      reason: alarm.type,
      aid: alarm.aid,
      "if.type": i_type,
      "if.target": i_target,
      category: (userInput && userInput.category) || ""
    });
    switch (i_type) {
      case "mac":
        e["p.device.mac"] = alarm["p.device.mac"];
        e["target_name"] = alarm["p.device.name"];
        e["target_ip"] = alarm["p.device.ip"];
        break;
      case "ip":
        e["p.dest.ip"] = alarm["p.dest.ip"];
        e["target_name"] = alarm["p.dest.name"] || alarm["p.dest.ip"];
        e["target_ip"] = alarm["p.dest.ip"];
        break;
      case "domain":
      case "dns":
        e["p.dest.name"] = `*.${i_target}` // add *. prefix to domain for dns matching
        e["target_name"] = `*.${i_target}`
        e["target_ip"] = alarm["p.dest.ip"];
        break;
      case "category":
        e["p.dest.category"] = i_target;
        e["target_name"] = i_target;
        e["target_ip"] = alarm["p.dest.ip"];
        break;
      case "country":
        e["p.dest.country"] = i_target;
        e["target_name"] = i_target;
        e["target_ip"] = alarm["p.dest.ip"];
        break;
      case "devicePort":
        e["p.device.mac"] = alarm["p.device.mac"];
        if (alarm.type === 'ALARM_UPNP') {
          e["p.upnp.private.port"] = alarm["p.upnp.private.port"];
          e["p.upnp.protocol"] = alarm["p.upnp.protocol"];
        }
        break
      case "deviceAllPorts":
        e["p.device.mac"] = alarm["p.device.mac"];
        break;
      case "deviceAppPort":
        e["p.device.mac"] = alarm["p.device.mac"];
        if (alarm.type === 'ALARM_UPNP') {
          const description = alarm["p.upnp.description"];
          if (description.startsWith("WhatsApp")) {
            e["p.upnp.description"] = "WhatsApp*"; //special handling for WhatsApp
          } else {
            e["p.upnp.description"] = description;
          }
        }
        break;
      case "ipOrg":
        e["e.dest.ip.org"] = i_target;
        if (alarm["p.device.mac"]) {
          e["p.device.mac"] = alarm["p.device.mac"];
        }
        break;
      case "sslO":
        e["e.dest.ssl.O"] = i_target;
        if (alarm["p.device.mac"]) {
          e["p.device.mac"] = alarm["p.device.mac"];
        }
        break;
      case "domainRegister":
        e["e.dest.domain.register"] = i_target;
        if (alarm["p.device.mac"]) {
          e["p.device.mac"] = alarm["p.device.mac"];
        }
        break;
      default:
        // not supported
        break;
    }
    if (userInput && userInput.device) {
      e["p.device.mac"] = userInput.device; // always attach p.device.mac info to expcetion if useInput applied
    }

    if (userInput && !_.isEmpty(userInput.tag)) {
      if (!userInput.device && e["p.device.mac"])
        delete e["p.device.mac"];
      for (const tagStr of userInput.tag) {
        if (tagStr.startsWith(Policy.INTF_PREFIX)) {
          let intfUuid = tagStr.substring(Policy.INTF_PREFIX.length);
          e["p.intf.id"] = intfUuid;
        } else {
          for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
            const config = Constants.TAG_TYPE_MAP[type];
            if (tagStr.startsWith(config.ruleTagPrefix)) {
              const tagUid = tagStr.substring(config.ruleTagPrefix.length);
              e[config.alarmIdKey] = [tagUid];
            }
          }
        }
      }
    }

    if (userInput && userInput.intf) {
      if (!userInput.device && e["p.device.mac"])
        delete e["p.device.mac"];
      e["p.intf.id"] = userInput.intf;
    }

    const extraProps = ["cronTime", "duration", "expireTs", "idleTs"];
    for (const prop of extraProps) {
      if (userInput.hasOwnProperty(prop))
        e[prop] = userInput[prop];
    }

    for (const key of Object.keys(userInput)) {
      if (key.startsWith("p.")) {
        e[key] = userInput[key];
      }
    }
    log.info("Exception object:", e);
    return e;
  }
}
