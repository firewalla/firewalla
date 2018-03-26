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

const cronParser = require('cron-parser');
const moment = require('moment');

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
    return instance;
  }  

  shouldPolicyBeRunning(policy) {
    const cronTime = policy.cronTime
    const duration = parseFloat(policy.duration) // in seconds

    if(!cronTime || !duration) {
      return 0
    }

    const interval = cronParser.parseExpression(cronTime)
    const lastDate = interval.prev()
    const now = moment()

    const diff = now.diff(moment(lastDate), 'seconds')

    if(diff < duration - MIN_DURATION) {
      return duration - diff // how many seconds left
    } else {
      return 0
    }
  }

  enforce(policy) {
    return async(() => {
      log.info(`=== Enforcing policy ${policy.pid}`)
      if(this.enforceCallback) {
        await (this.enforceCallback(policy))
      }
      log.info(`Policy ${policy.pid} is enforced`)
    })()
  }

  unenforce(policy) {
    return async(() => {
      log.info(`=== Unenforcing policy ${policy.pid}`)
      if(this.unenforceCallback) {
        await (this.unenforceCallback(policy))
      }
    })()
  }

  apply(policy, duration) {
    duration = duration || policy.duration
    
    const pid = policy.pid

    return async(() => {
      await (this.enforce(policy))

      const timer = setTimeout(() => {     // when timer expires, it will unenforce policy
        async(() => {
          await (this.unenforce(policy))
          delete policyTimers[pid]
        })()          
      }, parseFloat(duration) * 1000)

      policyTimers[pid] = timer;

    })()
  }

  registerPolicy(policy) {
    const cronTime = policy.cronTime
    const duration = policy.duration
    if(!cronTime || !duration) {
      const err = `Invalid Cron Time ${cronTime} / duration ${duration} for policy ${policy.pid}`
      log.error(err)
      return Promise.reject(new Error(err))
    }

    const pid = policy.pid

    if(runningCronJobs[pid]) { // already have a running job for this pid
      const err = `Already have cron job running for policy ${pid}`
      log.error(err)
      return Promise.reject(new Error(err))
    }

    try {
      log.info(`Registering policy ${policy.pid} for reoccuring`)
      const job = new CronJob(cronTime, () => {
        this.apply(policy)
      }, 
      () => {},
      true // enable the job
      );
      
      runningCronJobs[pid] = job // register job

      const x = this.shouldPolicyBeRunning(policy) // it's in policy activation period when starting FireMain
      if(x > 0) {
        return this.apply(policy, x)
      }

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

    log.info(`deregistering policy ${pid}`)

    const timer = policyTimers[pid]
    const job = runningCronJobs[pid]

    if(!job) {
      job.stop()
      delete runningCronJobs[pid]
    }    

    if(timer) {
      return async(() => {
        await (this.unenforce(policy))
        delete policyTimers[pid]
      })()      
    }
  }
}

module.exports = function() { return new PolicyScheduler() }

