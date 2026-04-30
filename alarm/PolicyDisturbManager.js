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
const crypto = require('crypto');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const Message = require('../net2/Message.js');
const AsyncLock = require('../vendor_lib/async-lock');
const Constants = require('../net2/Constants.js');
const lock = new AsyncLock();
const LOCK_RW = "lock_rw";
const TARGET_APP_PREFIXES = ['TLX-fw-', 'TLX-dt-'];

function _shortHash(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 8);
}

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
    if (!target)
      return "";
    for (const prefix of TARGET_APP_PREFIXES) {
      if (target.startsWith(prefix))
        return target.substring(prefix.length);
    }
    return target;
  }

  _resolveDisturbParams(target, policy) {
    const appName = this._getAppNameFromTarget(target) || policy.app_name || "";
    const disturbLevel = policy.disturbLevel || "";
    const params = { rateLimit: 10240, dropPacketRate: 0, increaseLatency: 0 };
    let disableQuic = false;

    if (_.has(this._appConfValue, appName)) {
      disableQuic = this._appConfValue[appName].disableQuic || false;
      if (_.has(this._appConfValue[appName], disturbLevel))
        Object.assign(params, this._appConfValue[appName][disturbLevel]);
    } else if (_.has(this._generalConfValue, disturbLevel)) {
      Object.assign(params, this._generalConfValue[disturbLevel]);
    }

    if (policy.disturbMethod)
      Object.assign(params, policy.disturbMethod);

    return { appName, params, disableQuic };
  }

  // Split one policy (potentially multi-target) into per-target effective policies,
  // each with its own resolved QoS params and a stable qosSubKey for QoS handler allocation.
  // Also collect the subset of targets that need QUIC blocking into a single sub-policy,
  // so block UDP/443 is delivered at parent pid level (avoids mark/ipset collisions).
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
      const { appName, params, disableQuic } = this._resolveDisturbParams(target, policy);
      if (disableQuic) {
        quicBlockTargets.push(target);
      }

      const effective = Object.assign(Object.create(Policy.prototype), policy, params, {
        target,
        targets: undefined,
        app_name: appName || policy.app_name,
        disableQuic: false, // handled at parent level via quicBlockTargets
        qosSubKey: multiTarget ? `disturb_${pid}_${_shortHash(target)}` : undefined,
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
    const state = this.registeredPolicies[pid];
    if (!state)
      return;

    const PolicyManager2 = require('./PolicyManager2.js');
    const pm2 = new PolicyManager2();
    for (const p of state.effectivePolicies) {
      p.disturbPretreatDone = true;
      await pm2.enforce(p);
    }
    if (!_.isEmpty(state.quicBlockTargets)) {
      const quicBlock = this._buildQuicBlockPolicy(state.policy, state.quicBlockTargets);
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
  }

}

module.exports = new PolicyDisturbManager();
