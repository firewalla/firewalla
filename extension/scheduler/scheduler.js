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

'use strict'

const log = require('../../net2/logger.js')(__filename)

const CronJob = require('cron').CronJob;

const Promise = require('bluebird');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

let instance = null;

const runningCronJobs = {}
const enforcedPolicies = {}
const policyRules = {}

const INVALIDATE_POLICY_TRESHOLD = 2 * 60 // if the cronjob is not active in 2 minutes, just unenforce the policy => meaning it's out of cronjob range

// Seconds: 0-59
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
      setInterval(() => {
        this.tickGuardAll()
      }, 1000 * 60) // every minute
    }
    return instance;
  }  

  registerPolicy(policy) {
    const cronTime = policy.cronTime
    if(!cronTime) {
      return Promise.reject(`Invalid Cron Time ${cronTime} for policy ${policy.pid}`)
    }
    
    try {
      log.info(`Registering policy ${policy.pid} for reoccuring`)
      const job = new CronJob(cronTime, () => {
        this.policyTick(policy)
      }, 
      () => {},
      true // enable the job
      );
      
      runningCronJobs[policy.pid] = job
      policyRules[policy.pid] = policy

      return Promise.resolve()

    } catch (err) {
      log.error("Failed to register policy:", policy.pid, "error:", err, {})
      return Promise.reject(err)
    }
  }

  deregisterPolicy(policy) {
    const pid = policy.pid
    if(pid == undefined) {
      // ignore
      return Promise.resolve()
    }

    const job = runningCronJobs[pid]
    if(!job) {
      return Promise.resolve() // already deregistered
    }

    return async(() => {
      log.info(`Deregistering policy ${policy.pid} for reoccuring`)

      // cleanup... stop the job, unenforce and remove job entry from runningJobs
      job.stop()
      if(enforcedPolicies[pid]) {
        if(this.unenforceCallback) {
          await (this.unenforceCallback(policy))
        }
        delete enforcedPolicies[pid]
      }
      delete runningCronJobs[job]
      delete policyRules[pid]
    })()

  }

  // this will be executed per tick, the tick will be executed every minute when the cron job is on
  policyTick(policy) {
    const pid = policy.pid
    if(pid == undefined) {
      // ignore
      return Promise.resolve()
    }

    return async(() => {
      const flag = enforcedPolicies[pid]
      if(flag) {
        // already running, do nothing
      } else {
        // not running yet
        log.info(`Enforcing policy ${policy.pid}`)
        if(this.enforceCallback) {
          await (this.enforceCallback(policy))
        }
        enforcedPolicies[pid] = 1
      }
    })().catch((err) => {
      log.error("Got error when ticking policy:", err, {})
    })
  }

  // this is a guard tick to ensure policy is unenforced if time is outside the cron active period
  tickGuard(policy) {
    const pid = policy.pid
    if(pid == undefined) {
      // ignore
      return Promise.resolve()
    }

    return async(() => {
      const flag = enforcedPolicies[pid]
      const job = runningCronJobs[pid]
      if(flag && job) {
        const lastExecutionDate = job.lastDate() / 1000
        const now = new Date() / 1000
        if(now - lastExecutionDate > INVALIDATE_POLICY_TRESHOLD) {
          log.info(`Unenforcing policy ${policy.pid}`)

          if(this.unenforceCallback) {
            await (this.unenforceCallback(policy))
          }
          delete enforcedPolicies[pid]
        }
      }
    })()
  }
  
  tickGuardAll() {
    const pids = Object.keys(enforcedPolicies)
    pids.forEach((pid) => {
      if(policyRules[pid]) {
        this.tickGuard(policyRules[pid])
      }      
    })
  }

}

module.exports = function() { return new PolicyScheduler() }

