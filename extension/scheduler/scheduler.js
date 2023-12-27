/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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


//    sem.on("PolicyEnforcement")
// -> PolicyManager2.enforce()
// -> Scheduler.enforce()
// -> PolicyManager2._enforce()


'use strict'

const log = require('../../net2/logger.js')(__filename)

const CronJob = require('cron').CronJob;

const cronParser = require('cron-parser');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../../vendor_lib/moment-tz-data.json'));
const sysManager = require('../../net2/SysManager.js');
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const Message = require('../../net2/Message.js');

let instance = null;

const runningCronJobs = {}

const policyTimers = {} // if policy timer exists, if means it's activated

const INVALIDATE_POLICY_TRESHOLD = 2 * 60 // if the cronjob is not active in 2 minutes, just unenforce the policy => meaning it's out of cronjob range

const MIN_DURATION = 2 * 60

// Minutes: 0-59
// Hours: 0-23
// Day of Month: 1-31
// Months: 0-11 (Jan-Dec)
// Day of Week: 0-6 (Sun-Sat)

// generally policyTick is to keep policy enforced if active
// tickGuard is to keep policy unenforced if not active

class PolicyScheduler {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info(`System timezone is reloaded, schedule reload scheduled policies ...`);
        this.scheduleReload();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
    return instance;
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(async () => {
      const policyCopy = Object.keys(runningCronJobs).map(pid => runningCronJobs[pid].policy);
      for (const policy of policyCopy) {
        if (policy) {
          await this.deregisterPolicy(policy);
          await this.registerPolicy(policy);
        }
      }
    }, 5000);
  }

  shouldPolicyBeRunning(policy) {
    const cronTime = policy.cronTime
    const duration = parseFloat(policy.duration) // in seconds

    if (!cronTime || !duration) {
      return 0
    }

    const interval = cronParser.parseExpression(cronTime, {tz: sysManager.getTimezone()});
    const lastDate = interval.prev().getTime();
    const now = moment().tz(sysManager.getTimezone());

    const diff = now.diff(moment(lastDate).tz(sysManager.getTimezone()), 'seconds')

    if (diff < duration - MIN_DURATION) {
      return duration - diff // how many seconds left
    } else {
      return 0
    }
  }

  async enforce(policy) {
    log.info(`=== Enforcing policy ${policy.pid}`)
    if (this.enforceCallback) {
      await this.enforceCallback(policy);
    }
    log.info(`Policy ${policy.pid} is enforced`)
  }

  async unenforce(policy) {
    log.info(`=== Unenforcing policy ${policy.pid}`)
    if (this.unenforceCallback) {
      await this.unenforceCallback(policy);
    }
  }

  async apply(policy, duration) {
    duration = duration || policy.duration

    const pid = policy.pid

    await this.enforce(policy);

    const timer = setTimeout(async () => {     // when timer expires, it will unenforce policy
      await this.unenforce(policy).catch(err => {
        log.error('Error unenforcing scheduled policy', err)
      });
      delete policyTimers[pid];
    }, parseFloat(duration) * 1000)

    policyTimers[pid] = timer;
  }

  async registerPolicy(policy) {
    const cronTime = policy.cronTime
    const duration = policy.duration
    if (!cronTime || !duration) {
      const err = `Invalid Cron Time ${cronTime} / duration ${duration} for policy ${policy.pid}`
      log.error(err)
      throw new Error(err);
    }

    const pid = policy.pid

    if (runningCronJobs[pid]) { // already have a running job for this pid
      const err = `Already have cron job running for policy ${pid}`
      log.error(err)
      throw new Error(err);
    }

    try {
      log.info(`Registering policy ${policy.pid} for reoccuring`)
      const tz = sysManager.getTimezone();
      const job = new CronJob(cronTime, () => {
        this.apply(policy).catch(err => {
          log.error('Error applying scheduled policy', err)
        })
      },
      () => {},
      true, // enable the job
      tz); // set local timezone. Otherwise FireMain seems to use UTC in the first running after initail pairing.

      runningCronJobs[pid] = {policy, job}; // register job

      const x = this.shouldPolicyBeRunning(policy) // it's in policy activation period when starting FireMain
      if (x > 0) {
        return this.apply(policy, x);
      }

      return;

    } catch (err) {
      log.error("Failed to register policy:", policy.pid, "error:", err);
      throw err;
    }
  }

  async deregisterPolicy(policy) {
    const pid = policy.pid
    if (pid == undefined) {
      // ignore
      return;
    }

    log.info(`deregistering policy ${pid}`)

    const timer = policyTimers[pid]
    const job = runningCronJobs[pid] && runningCronJobs[pid].job;

    if (job) {
      job.stop()
      delete runningCronJobs[pid]
    }

    if (timer) {
      await this.unenforce(policy);
        clearTimeout(timer);
        delete policyTimers[pid]
    }
  }
}

module.exports = new PolicyScheduler();

