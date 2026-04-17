/*    Copyright 2016-2026 Firewalla Inc.
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
const Sensor = require('./Sensor.js').Sensor;
const extensionManager = require('./ExtensionManager.js');
const AccessRequestManager = require('../alarm/AccessRequestManager.js');
const LOCK_BYPASS_RULE_UPDATE = "LOCK_BYPASS_RULE_UPDATE";
const _ = require('lodash');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const sem = require('./SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();
const Policy = require('../alarm/Policy.js');
const Constants = require('../net2/Constants.js');

class AccessRequestSensor extends Sensor {
  constructor(config) {
    super(config);
    this.tagManager = require('../net2/TagManager.js');;
  }

  apiRun() {
    extensionManager.onCmd('approveAccessRequest', async (msg, data) => {
      const requestId = data && data.requestId;
      if (!requestId) {
        throw { code: 400, msg: 'requestId is required' };
      }
      let approvedQuota = data && data.approvedQuota != null ? data.approvedQuota : undefined;
      if (approvedQuota != null) {
        const num = Number(approvedQuota);
        if (Number.isNaN(num)) {
          throw { code: 400, msg: 'approvedQuota must be a number' };
        }
        if (num <= 0 || num >= 86400) {
          throw { code: 400, msg: 'approvedQuota must be greater than 0 and less than 86400' };
        }
        approvedQuota = num;
      }
      const result = await AccessRequestManager.getInstance().approveRequest(requestId, approvedQuota);
      if (!result.ok) {
        throw { code: 400, msg: result.error || 'Failed to approve' };
      }
      return result.request;
    });

    extensionManager.onCmd('denyAccessRequest', async (msg, data) => {
      const requestId = data && data.requestId;
      if (!requestId) {
        throw { code: 400, msg: 'requestId is required' };
      }
      const reason = data && data.reason;
      const result = await AccessRequestManager.getInstance().denyRequest(requestId, reason);
      if (!result.ok) {
        throw { code: 400, msg: result.error || 'Failed to deny' };
      }
      return result.request;
    });

    extensionManager.onCmd('listExtraTimeRequests', async (msg, data) => {
      const options = data || {};
      const filterOpts = {};
      if (options.todayOnly) {
        filterOpts.todayOnly = true;
      }
      if (options.app) {
        filterOpts.app = new Set([options.app]);
      }
      if (options.userId) {
        filterOpts.userId = new Set([options.userId]);
      }
      const result = await AccessRequestManager.getInstance().listAllRequests(filterOpts);
      return result;
    });
  }

  run() {
    log.info("AccessRequestSensor started");
    sem.on("Policy:Activated", async (event) => {
      await lock.acquire(LOCK_BYPASS_RULE_UPDATE, async () => {
        const policy = event.policy;
        if (!policy || !policy.pid)
          return;
        await this.updateRelatedBypassPolicies(policy, "add");
      });
    });

    sem.on("Policy:Deactivated", async (event) => {
      await lock.acquire(LOCK_BYPASS_RULE_UPDATE, async () => {
        // check if any existing bypass rule for this user/app
        // if yes, remove the pid from the affectedPids of the bypass rule
        const policy = event.policy;
        if (!policy || !policy.pid)
          return;
        await this.updateRelatedBypassPolicies(policy, "remove");
      });
    });
  }

  async updateRelatedBypassPolicies(policy, action) {
    const pid = String(policy.pid);
    // check if any existing bypass rule for this user/app
    // if yes, add pid into the affectedPids of the bypass rule
    if (policy.type === "category" && (policy.action == "block" || policy.action == "disturb" || policy.action == "app_block")) {

      const tags = Object.values(this.tagManager.tags);
      for (let uid in tags) {
        const { user, afTag } = AccessRequestManager.getUserRelatedTags(uid);
      
        const ruleTagValues = new Set();
        const addRuleTag = (tag) => {
          if (!tag || !tag.getTagType) return;
          const prefix = Constants.TAG_TYPE_MAP[tag.getTagType()] && Constants.TAG_TYPE_MAP[tag.getTagType()].ruleTagPrefix;
          const uid = tag.getUniqueId && tag.getUniqueId();
          if (prefix && uid != null) ruleTagValues.add(prefix + uid);
        };
        addRuleTag(user);
        addRuleTag(afTag);
      
        const policyTargetsUserOrGroup = (p) => p.tag && p.tag.some(t => ruleTagValues.has(t));
        if (!policyTargetsUserOrGroup(policy)) continue;

        const apps = AccessRequestManager.getAppsFromPolicy(policy);
        const bypassPolicyKey = AccessRequestManager.getInstance().getBypassPolicyKey(uid, apps);
        const bypassPolicyId = await rclient.getAsync(bypassPolicyKey);
        if (bypassPolicyId) {
          const oldPolicy = await pm2.getPolicy(parseInt(bypassPolicyId));
          let updateNeeded = false;
          if (oldPolicy) {
            const affectedPids = new Set(oldPolicy.affectedPids || []);
            if (action === "add" && !affectedPids.has(pid)) {
              log.info(`Adding bypass policy ${oldPolicy.pid} for affected policy ${pid}, original affectedPids: ${oldPolicy.affectedPids}`);
              affectedPids.add(pid);
              updateNeeded = true;
            } else if (action === "remove" && affectedPids.has(pid)) {
              log.info(`Removing bypass policy ${oldPolicy.pid} for affected policy ${pid}, original affectedPids: ${oldPolicy.affectedPids}`);
              affectedPids.delete(pid);
              updateNeeded = true;
            }
            if (updateNeeded) {
              const newPolicy = new Policy(Object.assign({}, oldPolicy));
              newPolicy.affectedPids = Array.from(affectedPids);
              await pm2.updatePolicyAsync(newPolicy);
              const updatedPolicy = await pm2.getPolicy(oldPolicy.pid);
              if (updatedPolicy) {
                pm2.tryPolicyEnforcement(updatedPolicy, "reenforce", oldPolicy);
              }
            }
          }
        }
      }
    }

  }
}

module.exports = AccessRequestSensor;
