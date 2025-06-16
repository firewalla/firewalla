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

'use strict'

const log = require('../net2/logger.js')(__filename);
const Policy = require('./Policy.js');
const _ = require('lodash');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const Message = require('../net2/Message.js');
const AsyncLock = require('../vendor_lib/async-lock');
const Constants = require('../net2/Constants.js');
const lock = new AsyncLock();
const LOCK_RW = "lock_rw";

class PolicyDisturbManager {

  constructor() {
    this.registeredPolicies = {};

    this._disturbDefaultValue = {};
    this.loadConfig();

    sem.on(Message.MSG_APP_DISTURB_VALUE_UPDATED, async (event) => {
      if (!event || !event.disturbConfs) {
        log.error(`Invalid event for ${Message.MSG_APP_DISTURB_VALUE_UPDATED}`);
        return;
      }
      if (_.isEqual(this._disturbDefaultValue, event.disturbConfs))
        return;
      this._disturbDefaultValue = event.disturbConfs;
      log.info(`Received ${Message.MSG_APP_DISTURB_VALUE_UPDATED} event, updating app disturb default value`);
      const pids = Object.keys(this.registeredPolicies);
      for (const pid of pids) {
        const policy = this.registeredPolicies[pid];
        if (!policy) continue;
        try {
          await this.deregisterPolicy(policy);
          await this.registerPolicy(policy);
        } catch (error) {
          log.error(`Failed to refresh policy ${pid}:`, error);
        }
      }
    });
  }

  async loadConfig() {
    log.info(`Loading policy disturb config ...`);
    this._disturbDefaultValue = {};
    let policyDisturbConfig = await rclient.getAsync(Constants.REDIS_KEY_POLICY_DISTURB_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);

    if (policyDisturbConfig && policyDisturbConfig.disturbConfs) {
      this._disturbDefaultValue = policyDisturbConfig.disturbConfs;
    } else {
      log.warn(`No app disturb config found, using empty default value`);
    }
  }

  async registerPolicy(policy) {
    await lock.acquire(LOCK_RW, async () => {
      const pid = String(policy.pid);
      if (pid && _.has(this.registeredPolicies, pid)) {
        log.warn(`Policy ${pid} is registered again before being deregistered, deregister the policy anyway before register ...`)
        await this._deregisterPolicy(policy).catch((err) => {
          log.error(`Failed to deregister policy before register`, policy, err.message);
        });
      }
      await this._registerPolicy(policy);
    }).catch((err) => {
      log.error(`Failed to register policy`, policy, err.message);
    });
  }

  async _registerPolicy(policy) {
    const pid = String(policy.pid);
    log.info(`Registering policy ${pid} ...`);

    //set default default values
    policy.disturbLevel = policy.disturbLevel || "moderate";
    let defaultDisturbVal = { "rateLimit": 64, "dropPacketRate": 40, "increaseLatency": 200 };
    if (this._disturbDefaultValue && this._disturbDefaultValue.hasOwnProperty(policy.disturbLevel)) {
      defaultDisturbVal = Object.assign(defaultDisturbVal, this._disturbDefaultValue[policy.disturbLevel]);
    }
    policy = Object.assign(policy, defaultDisturbVal);

    this.registeredPolicies[pid] = policy;

    await this.enforcePolicy(pid);
  }

  async enforcePolicy(pid) {
    if (!this.registeredPolicies[pid])
      return;
    let p = Object.assign(Object.create(Policy.prototype), this.registeredPolicies[pid]);
    p.disturbPretreatDone = true;

    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    await pm2.enforce(p);
  }

  async deregisterPolicy(policy) {
    await lock.acquire(LOCK_RW, async () => {
      await this._deregisterPolicy(policy);
    }).catch((err) => {
      log.error(`Failed to deregister policy`, policy, err.message);
    });
  }

  async _deregisterPolicy(policy) {
    const pid = String(policy.pid);
    log.info(`Deregistering policy ${pid} ...`);

    await this.unenforcePolicy(pid);

    delete this.registeredPolicies[pid];
  }

  async unenforcePolicy(pid) {
    if (!this.registeredPolicies[pid])
      return;
    let p = Object.assign(Object.create(Policy.prototype), this.registeredPolicies[pid]);
    p.disturbPretreatDone = true;

    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    await pm2.unenforce(p);
  }

}

module.exports = new PolicyDisturbManager();