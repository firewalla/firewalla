/*    Copyright 2016-2023 Firewalla Inc.
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

'use strict'

const log = require('../net2/logger.js')(__filename);
const Policy = require('./Policy.js');
const TimeUsageTool = require('../flow/TimeUsageTool.js');
const _ = require('lodash');
const sysManager = require('../net2/SysManager.js');
const cronParser = require('cron-parser');
const CronJob = require('cron').CronJob;
const IdentityManager = require('../net2/IdentityManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');
const AsyncLock = require('../vendor_lib/async-lock');
const Constants = require('../net2/Constants.js');
const TagManager = require('../net2/TagManager.js');
const lock = new AsyncLock();
const LOCK_RW = "lock_rw";
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const POLICY_STATE_DEFAULT_MODE = 1;
const POLICY_STATE_DOMAIN_ONLY = 2;

class AppTimeUsageManager {
  constructor() {
    this.watchList = {};
    this.jobs = {};
    this.registeredPolicies = {};
    this.enforcedPolicies = {};
    this.policyTimeoutTasks = {};

    this._changedAppUIDs = {};
    sem.on(Message.MSG_APP_TIME_USAGE_BUCKET_INCR, (event) => {
      lock.acquire(LOCK_RW, async() => {
        const {app, uids} = event;
        for (const uid of uids) {
          if (!this._changedAppUIDs[app])
            this._changedAppUIDs[app] = {};
          this._changedAppUIDs[app][uid] = 1;
        }
      }).catch((err) => {
        log.error(`Failed to process ${Message.MSG_APP_TIME_USAGE_BUCKET_INCR} event`, err.message);
      });
    });
    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info("System timezone is reloaded, schedule refresh app time usage rules ...");
        const pids = Object.keys(this.registeredPolicies);
        for (const pid of pids) {
          const policy = this.registeredPolicies[pid];
          if (policy) {
            await this.deregisterPolicy(policy);
            await this.registerPolicy(policy);
          }
        }
      }
    });

    setInterval(async () => {
      await lock.acquire(LOCK_RW, async () => {
        for (const app of Object.keys(this._changedAppUIDs)) {
          if (!this.watchList[app])
            continue;
          for (const uid of Object.keys(this._changedAppUIDs[app])) {
            if (!this.watchList[app][uid])
              continue;
            for (const pid of Object.keys(this.watchList[app][uid])) {
              const {timeWindows, quota, uniqueMinute} = this.watchList[app][uid][pid];
              const usage = await this.getTimeUsage(uid, app, timeWindows, uniqueMinute);
              this.watchList[app][uid][pid].usage = usage;
              try {
                await this.updateAppTimeUsedInPolicy(pid, usage);
                if (usage >= quota && !this.enforcedPolicies[pid][uid]) {
                  log.info(`${uid} reached ${app} time usage quota, quota: ${quota}, used: ${usage}, will apply policy ${pid}`);
                  // a default mode policy will be applied first, and will be updated to domain only after a certain timeout
                  await this.enforcePolicy(this.registeredPolicies[pid], uid, false);
                  this.enforcedPolicies[pid][uid] = POLICY_STATE_DEFAULT_MODE;
                  this.policyTimeoutTasks[pid][uid] = setTimeout(async () => {
                    await lock.acquire(LOCK_RW, async () => {
                      if (this.policyTimeoutTasks[pid][uid] && this.enforcedPolicies[pid][uid] === POLICY_STATE_DEFAULT_MODE) {
                        await this.unenforcePolicy(this.registeredPolicies[pid], uid, false);
                        await this.enforcePolicy(this.registeredPolicies[pid], uid, true);
                        this.enforcedPolicies[pid][uid] = POLICY_STATE_DOMAIN_ONLY;
                        delete this.policyTimeoutTasks[pid][uid];
                      }
                    }).catch((err) => {
                      log.error(`Failed to apply domain only rule on policy ${pid}`, err.message);
                    });
                  }, 60 * 1000);
                }
              } catch (err) {
                log.error(`Failed to update app time used in policy ${pid}`, err.message);
              }
            }
          }
        }
        this._changedAppUIDs = {};
      }).catch((err) => {
        log.error(`Failed to refresh time usage`, err.message);
      });
    }, 60 * 1000);
  }

  calculateTimeWindows(period, intervals) {
    const periodExpr = cronParser.parseExpression(period, {tz: sysManager.getTimezone()});
    const periodBeginTs = periodExpr.prev().getTime(); // in milliseconds
    const periodEndTs = periodExpr.next().getTime();
    const timeWindows = [];
    if (_.isArray(intervals)) {
      for (const interval of intervals) {
        const {begin, end} = interval;
        const beginExpr = cronParser.parseExpression(begin, {tz: sysManager.getTimezone()});
        const endExpr = cronParser.parseExpression(end, {tz: sysManager.getTimezone()});
        const prevBeginTs = beginExpr.prev().getTime();
        const nextBeginTs = beginExpr.next().getTime();
        const prevEndTs = endExpr.prev().getTime();
        const nextEndTs = endExpr.next().getTime();
        if (prevBeginTs >= periodBeginTs && prevBeginTs <= periodEndTs && prevEndTs >= periodBeginTs && prevEndTs <= periodEndTs && prevBeginTs <= prevEndTs)
          timeWindows.push({begin: prevBeginTs, end: prevEndTs});
        if (prevBeginTs >= periodBeginTs && prevBeginTs <= periodEndTs && nextEndTs >= periodBeginTs && nextEndTs <= periodEndTs && prevBeginTs <= nextEndTs)
          timeWindows.push({begin: prevBeginTs, end: nextEndTs});
        if (nextBeginTs >= periodBeginTs && nextBeginTs <= periodEndTs && nextEndTs >= periodBeginTs && nextEndTs <= periodEndTs && nextBeginTs <= nextEndTs)
          timeWindows.push({begin: nextBeginTs, end: nextEndTs});
      }
    } else {
      timeWindows.push({begin: periodBeginTs, end: periodEndTs});
    }
    return timeWindows;
  }

  async getTimeUsage(uid, app, timeWindows, uniqueMinute) {
    let result = 0;
    for (const timeWindow of timeWindows) {
      const {begin, end} = timeWindow;
      result += await TimeUsageTool.getFilledBucketsCount(uid, app, begin / 1000, end / 1000, uniqueMinute);
    }
    return result;
  }

  getUIDs(policy) {
    const uids = [];
    if (_.isArray(policy.scope))
      Array.prototype.push.apply(uids, policy.scope);
    if (_.isArray(policy.tag)) {
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const ruleTagPrefix = _.get(Constants.TAG_TYPE_MAP, [type, "ruleTagPrefix"]);
        // convert all tag types to tag: prefix, matching uids in MSG_APP_TIME_USAGE_BUCKET_INCR event
        if (ruleTagPrefix)
          Array.prototype.push.apply(uids, policy.tag.filter(t => t.startsWith(ruleTagPrefix)).map(uid => `tag:${uid.substring(ruleTagPrefix.length)}`));
      }
    }
    if (_.isArray(policy.guids))
      Array.prototype.push.apply(uids, policy.guids);
    if (_.isEmpty(uids))
      uids.push("global");
    return uids;
  }

  async refreshPolicy(policy) {
    const pid = String(policy.pid);
    log.info(`Refreshing time usage on policy ${pid} ...`);
    const {app, period, intervals, quota, uniqueMinute = true} = policy.appTimeUsage;
    if (!this.watchList.hasOwnProperty(app))
      this.watchList[app] = {};
    const uids = this.getUIDs(policy);

    for (const uid of Object.keys(this.enforcedPolicies[pid])) {
      await this.unenforcePolicy(policy, uid, this.enforcedPolicies[pid][uid] === POLICY_STATE_DOMAIN_ONLY);
    }
    this.enforcedPolicies[pid] = {};
    for (const uid of Object.keys(this.policyTimeoutTasks[pid]))
      clearTimeout(this.policyTimeoutTasks[pid][uid]);
    this.policyTimeoutTasks[pid] = {};

    const timeWindows = this.calculateTimeWindows(period, intervals);
    for (const uid of uids) {
      if (!this.watchList[app].hasOwnProperty(uid))
        this.watchList[app][uid] = {};
      const usage = await this.getTimeUsage(uid, app, timeWindows, uniqueMinute);
      this.watchList[app][uid][pid] = {quota, usage, timeWindows, uniqueMinute};
      await this.updateAppTimeUsedInPolicy(pid, usage);
      if (usage >= quota) {
        log.info(`${uid} reached ${app} time usage quota, quota: ${quota}, used: ${usage}, will apply policy ${pid}`);
        // a default mode policy will be applied first, and will be updated to domain only after a certain timeout
        await this.enforcePolicy(policy, uid, false);
        this.enforcedPolicies[pid][uid] = POLICY_STATE_DEFAULT_MODE;
        this.policyTimeoutTasks[pid][uid] = setTimeout(async () => {
          await lock.acquire(LOCK_RW, async () => {
            if (this.policyTimeoutTasks[pid][uid] && this.enforcedPolicies[pid][uid] === POLICY_STATE_DEFAULT_MODE) {
              await this.unenforcePolicy(this.registeredPolicies[pid], uid, false);
              await this.enforcePolicy(this.registeredPolicies[pid], uid, true);
              this.enforcedPolicies[pid][uid] = POLICY_STATE_DOMAIN_ONLY;
              delete this.policyTimeoutTasks[pid][uid];
            }
          }).catch((err) => {
            log.error(`Failed to apply domain only rule on policy ${pid}`, err.message);
          });
        }, 60 * 1000);
      }
    }
  }

  async registerPolicy(policy) {
    await lock.acquire(LOCK_RW, async () => {
      const pid = String(policy.pid);
      log.info(`Registering policy ${pid} ...`);
      const { period } = policy.appTimeUsage;
      const tz = sysManager.getTimezone();

      this.enforcedPolicies[pid] = {};
      this.policyTimeoutTasks[pid] = {};
      this.registeredPolicies[pid] = policy;
      const periodJob = new CronJob(period, async () => {
        await lock.acquire(LOCK_RW, async () => {
          await this.refreshPolicy(policy);
        }).catch((err) => {
          log.error(`Failed to refresh policy period`, policy, err.message);
        });
      }, () => { }, true, tz);
      this.jobs[pid] = periodJob;

      await this.refreshPolicy(policy);
    }).catch((err) => {
      log.error(`Failed to register policy`, policy, err.message);
    });
  }

  async deregisterPolicy(policy) {
    await lock.acquire(LOCK_RW, async () => {
      const pid = String(policy.pid);
      log.info(`Deregistering policy ${pid} ...`);
      const job = this.jobs[pid];
      if (job) {
        job.stop();
        delete this.jobs[pid];
      }
      const { app } = policy.appTimeUsage;
      const uids = this.getUIDs(policy);
      for (const uid of uids) {
        if (this.watchList[app] && this.watchList[app][uid])
          delete this.watchList[app][uid][pid];
      }
      if (_.isObject(this.enforcedPolicies[pid])) {
        for (const uid of Object.keys(this.enforcedPolicies[pid]))
          await this.unenforcePolicy(policy, uid, this.enforcedPolicies[pid][uid] === POLICY_STATE_DOMAIN_ONLY);
        delete this.enforcedPolicies[pid];
      }
      if (_.isObject(this.policyTimeoutTasks[pid])) {
        for (const uid of Object.keys(this.policyTimeoutTasks[pid]))
          clearTimeout(this.policyTimeoutTasks[pid][uid]);
        delete this.policyTimeoutTasks[pid];
      }
      delete this.registeredPolicies[pid];
    }).catch((err) => {
      log.error(`Failed to deregister policy`, policy, err.message);
    });
  }

  async enforcePolicy(policy, uid, domainOnly = true) {
    const p = Object.assign(Object.create(Policy.prototype), policy);
    delete p.appTimeUsage;
    delete p.scope;
    delete p.guids;
    delete p.tag;
    if (uid && uid.startsWith(Policy.INTF_PREFIX))
      p.tag = [uid];
    else if (uid && uid.startsWith("tag:")) {
      const tag = await TagManager.getTagByUid(uid.substring("tag:".length));
      const tagType = tag && tag.getTagType() || Constants.TAG_TYPE_GROUP;
      p.tag = [`${Constants.TAG_TYPE_MAP[tagType].ruleTagPrefix}${uid.substring("tag:".length)}`];
    } else if (uid && IdentityManager.isGUID(uid))
      p.guids = [uid];
    else if (uid && hostTool.isMacAddress(uid))
      p.scope = [uid];

    if (p.type === "dns" || p.type === "category")
      p.dnsmasq_only = domainOnly;
    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    await pm2.enforce(p);
  }

  async unenforcePolicy(policy, uid, domainOnly = true) {
    const p = Object.assign(Object.create(Policy.prototype), policy);
    delete p.appTimeUsage;
    delete p.scope;
    delete p.guids;
    delete p.tag;
    if (uid && uid.startsWith(Policy.INTF_PREFIX))
      p.tag = [uid];
    else if (uid && uid.startsWith("tag:")) {
      const tag = await TagManager.getTagByUid(uid.substring("tag:".length));
      const tagType = tag && tag.getTagType() || Constants.TAG_TYPE_GROUP;
      p.tag = [`${Constants.TAG_TYPE_MAP[tagType].ruleTagPrefix}${uid.substring("tag:".length)}`];
    } else if (uid && IdentityManager.isGUID(uid))
      p.guids = [uid];
    else if (uid && hostTool.isMacAddress(uid))
      p.scope = [uid];

    if (p.type === "dns" || p.type === "category")
      p.dnsmasq_only = domainOnly;
    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    await pm2.unenforce(p);
  }

  async updateAppTimeUsedInPolicy(pid, used) {
    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    await pm2.updatePolicyAsync({pid, appTimeUsed: used});
  }
}

module.exports = new AppTimeUsageManager();