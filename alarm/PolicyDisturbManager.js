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
const DisturbDispatch = require('../control/DisturbDispatch.js');
const lock = new AsyncLock();
const LOCK_RW = "lock_rw";
const DISTURB_TARGET_PREFIX = 'TLX-dt-';

class PolicyDisturbManager {

  constructor() {
    this.registeredPolicies = {};

    this._generalConfValue = {};
    this._appConfValue = {};
    this.loadConfig();

    sem.on(Message.MSG_APP_DISTURB_VALUE_UPDATED, async (event) => {
      if (!event || !event.disturbConfs) {
        log.error(`Invalid event for ${Message.MSG_APP_DISTURB_VALUE_UPDATED}`);
        return;
      }
      if (_.isEqual(this._generalConfValue, event.disturbConfs.generalConfs) && _.isEqual(this._appConfValue, event.disturbConfs.appConfs))
        return;
      this._generalConfValue = event.disturbConfs.generalConfs || {};
      this._appConfValue = event.disturbConfs.appConfs || {};

      log.info(`Received ${Message.MSG_APP_DISTURB_VALUE_UPDATED} event, updating app disturb default value`);
      const pids = Object.keys(this.registeredPolicies);
      for (const pid of pids) {
        const state = this.registeredPolicies[pid];
        const policy = state && state.policy;
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
    this._generalConfValue = {};
    this._appConfValue = {};
    let policyDisturbConfig = await rclient.getAsync(Constants.REDIS_KEY_POLICY_DISTURB_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);

    if (policyDisturbConfig) {
      const { generalConfs, appConfs } = policyDisturbConfig;
      if (generalConfs) this._generalConfValue = generalConfs;
      if (appConfs) this._appConfValue = appConfs;
    }
    else {
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

  _getPolicyTargets(policy) {
    return _.uniq(_.compact(_.concat(policy.targets, policy.target)));
  }

  _getAppNameFromTarget(target) {
    if (!target) return "";
    if (target.startsWith(DISTURB_TARGET_PREFIX))
      return target.substring(DISTURB_TARGET_PREFIX.length);
    return target;
  }

  // TODO: support per-target disturbLevel / disturbMethod after the frontend schema lands.
  //       The caller is expected to pick the per-target slice (if any) before calling.
  _resolveDisturbParams(target, { fallbackAppName, disturbLevel, disturbMethod }) {
    const appName = this._getAppNameFromTarget(target) || fallbackAppName || "";

    // 1. defaults
    const params = { rateLimit: 10240, dropPacketRate: 0, increaseLatency: 0 };
    let disableQuic = false;

    // 2. cloud config
    const appConf = this._appConfValue[appName];
    const levelConf = appConf
      ? appConf[disturbLevel]
      : this._generalConfValue[disturbLevel];
    if (appConf) disableQuic = appConf.disableQuic || false;
    if (levelConf) Object.assign(params, levelConf);

    // 3. policy-level override
    if (disturbMethod) Object.assign(params, disturbMethod);

    return { appName, params, disableQuic };
  }

  _buildEffectivePolicies(policy) {
    const pid = String(policy.pid);
    const targets = this._getPolicyTargets(policy);

    if (_.isEmpty(targets)) {
      log.warn(`Policy ${pid} has no valid targets for disturb, skip`);
      return { effectivePolicies: [], quicBlockTargets: [] };
    }

    const multiTarget = targets.length > 1;
    const effectivePolicies = [];
    const quicBlockTargets = [];

    for (const target of targets) {
      const { appName, params, disableQuic } = this._resolveDisturbParams(target, {
        fallbackAppName: policy.app_name,
        disturbLevel: policy.disturbLevel,
        disturbMethod: policy.disturbMethod,
      });
      if (disableQuic) {
        quicBlockTargets.push(target);
      }

      const effective = Object.assign(Object.create(Policy.prototype), policy, params, {
        target,
        targets: undefined,
        app_name: appName,
        disableQuic: false, // handled at parent level via quicBlockTargets
        qosSubKey: multiTarget ? DisturbDispatch.subKeyFor(target) : undefined,
      });
      effectivePolicies.push(effective);
    }

    return { effectivePolicies, quicBlockTargets };
  }

  _buildQuicBlockPolicy(policy, quicBlockTargets) {
    return Object.assign(Object.create(Policy.prototype), policy, {
      action: "block",
      protocol: "udp",
      remotePort: "443",
      dnsmasq_only: false,
      target: quicBlockTargets[0],
      targets: quicBlockTargets.slice(),
      disableQuic: false,
      qosSubKey: undefined,
      disturbPretreatDone: true,
    });
  }

  async _registerPolicy(policy) {
    const pid = String(policy.pid);
    const { effectivePolicies, quicBlockTargets } = this._buildEffectivePolicies(policy);
    if (_.isEmpty(effectivePolicies))
      return;
    log.info(`Registering policy ${pid} disturbLevel=${policy.disturbLevel || "default"}, targets: ${JSON.stringify(effectivePolicies.map(p => ({ target: p.target, rateLimit: p.rateLimit, dropPacketRate: p.dropPacketRate, increaseLatency: p.increaseLatency })))}, quicBlockTargets=${JSON.stringify(quicBlockTargets)}`);
    this.registeredPolicies[pid] = { policy: { ...policy }, effectivePolicies, quicBlockTargets };

    await this.enforcePolicy(pid);
  }

  async enforcePolicy(pid) {
    const registeredPolicy = this.registeredPolicies[pid];
    if (!registeredPolicy)
      return;

    // Prepare iptables for multiple app disturb.
    await DisturbDispatch.setupDispatchForPolicy(registeredPolicy.policy);

    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    for (const p of registeredPolicy.effectivePolicies) {
      p.disturbPretreatDone = true;
      await pm2.enforce(p);
    }
    if (!_.isEmpty(registeredPolicy.quicBlockTargets)) {
      const quicBlock = this._buildQuicBlockPolicy(registeredPolicy.policy, registeredPolicy.quicBlockTargets);
      await pm2.enforce(quicBlock);
    }
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
    const state = this.registeredPolicies[pid];
    if (!state)
      return;

    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    if (!_.isEmpty(state.quicBlockTargets)) {
      const quicBlock = this._buildQuicBlockPolicy(state.policy, state.quicBlockTargets);
      await pm2.unenforce(quicBlock);
    }
    for (const p of state.effectivePolicies) {
      p.disturbPretreatDone = true;
      await pm2.unenforce(p);
    }

    await DisturbDispatch.teardownDispatchForPolicy(state.policy);
  }

}

module.exports = new PolicyDisturbManager();
