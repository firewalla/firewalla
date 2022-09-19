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

const log = require('../net2/logger.js')(__filename, 'info');
const Alarm = require('./Alarm.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const bone = require("../lib/Bone.js");

const flat = require('flat');

const util = require('util');

const moment = require('moment');

const fc = require('../net2/config.js')

const f = require('../net2/Firewalla.js');

const Promise = require('bluebird');

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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const alarmDetailPrefix = "_alarmDetail";

const _ = require('lodash');

const IntelManager = require('../net2/IntelManager.js')
const intelManager = new IntelManager('info');
const IdentityManager = require('../net2/IdentityManager.js');

// TODO: Support suppress alarm for a while

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
      this.publisher = new c('info');

      this.setupAlarmQueue();
    }
    return instance;
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
      log.debug('processing job', JSON.stringify(event))

      if (alarm["p.local.decision"] === "ignore") {
        log.info("Alarm ignored by p.local.decision:", alarm);
        return;
      }

      const action = event.action;

      switch (action) {
        case "create": {
          try {
            log.info("Try to create alarm:", event.alarm);
            let aid = await this.checkAndSaveAsync(alarm, event.profile);
            log.info(`Alarm ${aid} is created successfully`);
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
          log.error("unrecoganized policy enforcement action:" + action)
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

  updateAlarm(alarm) {
    let alarmKey = alarmPrefix + alarm.aid;
    return new Promise((resolve, reject) => {
      rclient.hmset(alarmKey, flat.flatten(alarm), (err) => {
        if (err) {
          log.error("Failed to set alarm: " + err);
          reject(err);
          return;
        }

        resolve(alarm);
      });
    });
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
      return
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
    const id = await this.getNextID();

    alarm.aid = id + ""; // covnert to string to make it consistent

    const alarmKey = alarmPrefix + id;

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

    const flatted = flat.flatten(alarm);

    const { basic, extended } = this.parseRawAlarm(flatted);

    await rclient.hmsetAsync(alarmKey, basic)

    let expiring = fConfig.sensors.OldDataCleanSensor.alarm.expires || 24 * 60 * 60 * 30;  // a month
    await rclient.expireatAsync(alarmKey, parseInt((+new Date) / 1000) + expiring);

    await this.addToActiveQueue(alarm);

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

    // record security alarm count on hostInfo
    if (alarm['p.device.mac'] && alarm.isSecurityAlarm()) {
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


    return alarm.aid;
  }

  async removeAlarmAsync(alarmID) {
    await rclient.zremAsync(alarmArchiveKey, alarmID);
    await this.removeFromActiveQueueAsync(alarmID);
    await this.deleteExtendedAlarm(alarmID);
    await rclient.unlinkAsync(alarmPrefix + alarmID);
  }

  async deleteMacRelatedAlarms(mac) {
    let alarms = await this.loadRecentAlarmsAsync(60 * 60 * 24 * 7);
    let related = alarms
      .filter(alarm => _.isString(alarm['p.device.mac']) &&
        alarm['p.device.mac'].toUpperCase() === mac.toUpperCase())
      .map(alarm => alarm.aid);

    if (related.length) {
      await rclient.zremAsync(alarmActiveKey, related);
      await rclient.unlinkAsync(related.map(id => alarmDetailPrefix + id));
      await rclient.unlinkAsync(related.map(id => alarmPrefix + id));
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
        ':dedup: Dup Found! ExpirationTime: %s (%s)',
        moment.duration(duration * 1000).humanize(), duration,
      ));
      log.info(util.format(
        ':dedup: Latest alarm %s happened on %s, cooldown: %s (%s)',
        dupAlarmID,
        new Date(latest * 1000).toLocaleString(),
        moment.duration(cooldown * 1000).humanize(), cooldown.toFixed(2)
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
      log.warn("Same alarm is already generated, skipped this time", alarm.type);
      log.warn("destination: " + alarm["p.dest.name"] + ":" + alarm["p.dest.ip"]);
      log.warn("source: " + alarm["p.device.name"] + ":" + alarm["p.device.ip"]);
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

    const policyMatch = alarm.type === "ALARM_CUSTOMIZED" ? false : await pm2.match(alarm) // do not match alarm against rules for customized alarms

    if (policyMatch) {
      // already matched some policy

      const err2 = new Error("alarm is covered by policies");
      err2.code = 'ERR_BLOCKED_BY_POLICY_ALREADY';
      throw err2;
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
        log.info(`Decison from cloud is auto-block`, alarm.type, alarm["p.device.ip"], alarm["p.dest.ip"]);
      }
    }

    // HACK, update rdns if missing, sometimes intel contains ip => domain, but rdns entry is missing
    const destName = alarm["p.dest.name"]
    const destIP = alarm["p.dest.ip"]
    if (destName && destIP && destName !== destIP) {
      dnsTool.addReverseDns(destName, [destIP])
    }

    const alarmID = await this.saveAlarm(alarm)

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
          bone.submitIntelFeedback("autoblock", alarm, "alarm");
        }
      }

    } catch (err) {
      log.error('Failed on alarm autoblock', err)
    } finally {
      this.notifAlarm(alarm.aid);
    }

    return alarmID
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
        if (_.isString(value) && validator.isJSON(value)) {
          try {
            obj[key] = JSON.parse(value);
          } catch (err) { }
        }
      }
      return obj;
    } else {
      log.error("Unsupported alarm type: " + json.type);
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
    return results.map((r) => this.jsonToAlarm(r)).filter(Boolean)
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

  loadRecentAlarmsAsync(duration) {
    duration = duration || 10 * 60;
    return new Promise((resolve, reject) => {
      this.loadRecentAlarms(duration, (err, results) => {
        if (err) {
          reject(err)
        } else {
          resolve(results)
        }
      })
    })
  }

  loadRecentAlarms(duration, callback) {
    if (typeof (duration) == 'function') {
      callback = duration;
      duration = 10 * 60; // 10 minutes
    }

    callback = callback || function () { }

    let scoreMax = new Date() / 1000 + 1;
    let scoreMin;
    if (duration == "-inf") {
      scoreMin = "-inf";
    } else {
      scoreMin = scoreMax - duration;
    }

    rclient.zrevrangebyscore(alarmActiveKey, scoreMax, scoreMin, (err, alarmIDs) => {
      if (err) {
        log.error("Failed to load active alarms: " + err);
        callback(err);
        return;
      }
      this.idsToAlarms(alarmIDs, (err, results) => {
        if (err) {
          callback(err);
          return;
        }

        results = results.filter((a) => a != null);
        callback(err, results);
      });
    });
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
    return rclient.multi()
      .zrem(alarmActiveKey, alarmID)
      .zadd(alarmArchiveKey, 'nx', new Date() / 1000, alarmID)
      .execAsync();
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

  async loadActiveAlarmsAsync(options) {
    let count, ts, asc, type;

    if (_.isNumber(options)) {
      count = options;
    } else if (options) {
      ({ count, ts, asc, type } = options);
    }

    count = count || 50;
    ts = ts || Date.now() / 1000;
    asc = asc || false;
    type = type || 'active';
    let key = type == 'active' ? alarmActiveKey : alarmArchiveKey;

    let query = asc ?
      rclient.zrangebyscoreAsync(key, '(' + ts, '+inf', 'limit', 0, count) :
      rclient.zrevrangebyscoreAsync(key, '(' + ts, '-inf', 'limit', 0, count);

    let ids = await query;

    let alarms = await this.idsToAlarmsAsync(ids)

    return alarms.filter(a => a != null);
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

  async findSimilarAlarmsByPolicy(policy, curAlarmID) {
    let alarms = await this.loadActiveAlarmsAsync(200); // load 200 alarms for comparison
    return alarms.filter((alarm) => {
      if (alarm.aid === curAlarmID) {
        return false // ignore current alarm id, since it's already blocked
      }

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

      //@TODO need support array?
      if (info.tag) {
        p.tag.push(Policy.TAG_PREFIX + info.tag);
        if (p.scope && !info.device)
          delete p.scope;
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
    const alarms = await this.findSimilarAlarmsByPolicy(p, alarm.aid)
    const blockedAlarms = []
    for (const alarm of alarms) {
      try {
        await this.blockAlarmByPolicy(alarm, policy, info)
        blockedAlarms.push(alarm)
      } catch (err) {
        log.error(`Failed to block alarm ${alarm.aid} with policy ${policy.pid}: ${err}`)
      }
    }
    return { policy, blockedAlarms, alreadyExists }
  }

  allowFromAlarm(alarmID, info, callback) {
    log.info("Going to allow alarm " + alarmID);
    log.info("info: ", info);

    let userInput = info.info;

    this.getAlarm(alarmID)
      .then((alarm) => {

        log.info("Alarm to allow: ", alarm);

        if (!alarm) {
          log.error("Invalid alarm ID:", alarmID);
          callback(new Error("Invalid alarm ID: " + alarmID));
          return;
        }

        const e = this.createException(alarm, userInput);

        // FIXME: make it transactional
        // set alarm handle result + add policy

        exceptionManager.checkAndSave(e, async (err, exception, alreadyExists) => {
          if (err) {
            log.error("Failed to save exception: " + err);
            callback(err);
            return;
          }

          if (alreadyExists) {
            log.info(`exception ${e} already exists: ${exception}`)
          }

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
            callback(null, exception, allowedAlarms, alreadyExists)
          } else {
            log.info("No similar alarms are found")
            callback(null, exception, undefined, alreadyExists)
          }
        })
      }).catch((err) => {
        callback(err);
      })
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
    const result = await dnsManager.resolveLocalHostAsync(deviceIP)

    if (result == null) {
      log.error("Failed to find host " + deviceIP + " in database");
      throw new Error("host " + deviceIP + " not found");
    }

    let deviceName = getPreferredName(result);
    let deviceID = result.mac;

    Object.assign(alarm, {
      "p.device.name": deviceName,
      "p.device.id": deviceID,
      "p.device.mac": deviceID,
      "p.device.macVendor": result.macVendor || "Unknown"
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
        } else if (tagStr.startsWith(Policy.TAG_PREFIX)) {
          let tagUid = tagStr.substring(Policy.TAG_PREFIX.length);
          e["p.tag.ids"] = [tagUid];
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
