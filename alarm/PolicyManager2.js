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

'use strict'

const log = require('../net2/logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const Bone = require('../lib/Bone.js');

const sysManager = require('../net2/SysManager.js')
const tm = require('./TrustManager.js');

let instance = null;

const policyActiveKey = "policy_active";
const policyIDKey = "policy:id";
const policyPrefix = "policy:";
const policyDisableAllKey = "policy:disable:all";
const initID = 1;
const POLICY_MAX_ID = 65535; // iptables log use last 16 bit MARK as rule id
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_POLICY_ID = "LOCK_POLICY_ID";
const { Address4, Address6 } = require('ip-address');
const Host = require('../net2/Host.js');
const Constants = require('../net2/Constants.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Block = require('../control/Block.js');
const qos = require('../control/QoS.js');

const Policy = require('./Policy.js');

const HostTool = require('../net2/HostTool.js')
const ht = new HostTool()

const DomainIPTool = require('../control/DomainIPTool.js');
const domainIPTool = new DomainIPTool();

const domainBlock = require('../control/DomainBlock.js');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()
const CountryUpdater = require('../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

const scheduler = require('../extension/scheduler/scheduler.js')

const Queue = require('bee-queue')

const platform = require('../platform/PlatformLoader.js').getPlatform();
const policyCapacity = platform.getPolicyCapacity();

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const NetworkProfile = require('../net2/NetworkProfile.js');
const Tag = require('../net2/Tag.js');
const tagManager = require('../net2/TagManager')
const ipset = require('../net2/Ipset.js');
const _ = require('lodash');

const { delay, isSameOrSubDomain, batchKeyExists } = require('../util/util.js');
const validator = require('validator');
const iptool = require('ip');
const util = require('util');
const exec = require('child-process-promise').exec;
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

const IdentityManager = require('../net2/IdentityManager.js');
const Message = require('../net2/Message.js');
const AppTimeUsageManager = require('./AppTimeUsageManager.js');

const VPNClient = require('../extension/vpnclient/VPNClient.js');
let hostManager;

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const { map } = require('async');

const ruleSetTypeMap = {
  'ip': 'hash:ip',
  'net': 'hash:net',
  'remotePort': 'bitmap:port',
  'remoteIpPort': 'hash:ip,port',
  'remoteNetPort': 'hash:net,port'
}
const simpleRuleSetMap = {
  'ip': 'ip_set',
  'net': 'net_set',
  'remotePort': 'remote_port_set',
  'remoteIpPort': 'remote_ip_port_set',
  'remoteNetPort': 'remote_net_port_set',
  'domain': 'domain_set',
  'dns': 'domain_set'
}

const validActions = ["block", "allow", "qos", "route", "match_group", "alarm", "resolve", "address", "snat"];

class PolicyManager2 {
  constructor() {
    if (instance == null) {
      instance = this;

      scheduler.enforceCallback = (policy) => {
        const p = Object.assign(Object.create(Policy.prototype), policy);
        delete p.cronTime;
        return this.enforce(p); // recursively invoke enforce but removed the cronTime from the policy. It won't fall into scheduler again
      }

      scheduler.unenforceCallback = (policy) => {
        const p = Object.assign(Object.create(Policy.prototype), policy);
        delete p.cronTime;
        return this.unenforce(p); // recursively invoke unenforce but removed the cronTime from the policy. It won't fall into scheduler again
      }

      this.enabledTimers = {}
      this.disableAllTimer = null;
      this.domainBlockTimers = {};

      this.ipsetCache = null;
      this.ipsetCacheUpdateTime = null;
      this.sortedActiveRulesCache = null;
      this.sortedRoutesCache = null;
    }
    return instance;
  }

  shouldFilter(rule) {
    // this is to filter legacy schedule rules that is not compatible with current system any more
    // all legacy rules should already been migrated in OldDataCleanSensor, any leftovers should be bug
    // and here is a protection for that
    if (rule.cronTime && rule.cronTime.startsWith("* *")) {
      return true;
    }
    return false;
  }

  async setupPolicyQueue() {
    this.queue = new Queue('policy', {
      removeOnFailure: true,
      removeOnSuccess: true
    });

    this.queue.on('error', (err) => {
      log.error("Queue got err:", err)
    })

    this.queue.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${JSON.stringify(job.data)} failed with error ${err.message}`);
    });

    this.queue.destroy(() => {
      log.info("policy queue is cleaned up")
    })

    this.queue.process(async (job) => {
      const event = job.data;
      const policy = new Policy(event.policy);
      const oldPolicy = event.oldPolicy ? new Policy(event.oldPolicy) : null;
      const action = event.action

      if (this.shouldFilter(policy)) {
        return;
      }

      switch (action) {
        case "enforce": {
          try {
            log.verbose("START ENFORCING POLICY", policy.pid, action);
            await this.enforce(policy)
          } catch (err) {
            log.error("enforce policy failed", err, policy)
          } finally {
            log.verbose("COMPLETE ENFORCING POLICY", policy.pid, action);
          }
          break
        }

        case "unenforce": {
          try {
            log.info("START UNENFORCING POLICY", policy.pid, action);
            await this.unenforce(policy)
          } catch (err) {
            log.error("unenforce policy failed:" + err, policy)
          } finally {
            log.info("COMPLETE UNENFORCING POLICY", policy.pid, action);
          }
          break
        }

        case "reenforce": {
          try {
            if (!oldPolicy) {
              // do nothing
            } else {
              log.info("START REENFORCING POLICY", policy.pid, action);

              await this.unenforce(oldPolicy).catch((err) => {
                log.error("Failed to unenforce policy before reenforce", err.message, policy);
              });
              await this.enforce(policy).catch((err) => {
                log.error("Failed to reenforce policy", err.message, policy);
              })
            }
          } catch (err) {
            log.error("reenforce policy failed:" + err, policy)
          } finally {
            log.info("COMPLETE ENFORCING POLICY", policy.pid, action);
          }
          break
        }

        case "incrementalUpdate": {
          try {
            const list = await domainIPTool.getAllIPMappings()
            for (const l of list) {
              const matchDomain = l.match(/ipmapping:domain:(.*)/)
              if (matchDomain) {
                const domain = matchDomain[1]
                await domainBlock.incrementalUpdateIPMapping(domain, {})
                return
              }

              const matchBlockSetDomain = l.match(/ipmapping:blockset:({^:}*):domain:(.*)/);
              if (matchBlockSetDomain) {
                const blockSet = matchBlockSetDomain[1];
                const domain = matchBlockSetDomain[2];
                await domainBlock.incrementalUpdateIPMapping(domain, { blockSet: blockSet })
                return;
              }

              const matchExactDomain = l.match(/ipmapping:exactdomain:(.*)/)
              if (matchExactDomain) {
                const domain = matchExactDomain[1]
                await domainBlock.incrementalUpdateIPMapping(domain, { exactMatch: 1 })
                return
              }

              const matchBlockSetExactDomain = l.match(/ipmapping:blockset:({^:}*):exactdomain:(.*)/);
              if (matchBlockSetExactDomain) {
                const blockSet = matchBlockSetExactDomain[1];
                const domain = matchBlockSetExactDomain[2];
                await domainBlock.incrementalUpdateIPMapping(domain, { exactMatch: 1, blockSet: blockSet });
              }
            }
          } catch (err) {
            log.error("incremental update policy failed:", err);
          } finally {
            log.info("COMPLETE incremental update policy");
          }
          break
        }

        default:
          log.error("unrecoganized policy enforcement action:" + action)
          return
      }
    })

    setInterval(() => {
      this.queue.checkHealth((error, counts) => {
        log.debug("Policy queue status:", counts);
      })

    }, 60 * 1000)

    return this.queue.ready();
  }

  registerPolicyEnforcementListener() { // need to ensure it's serialized
    log.info("register policy enforcement listener")
    sem.on("PolicyEnforcement", (event) => {
      if (event && event.policy) {
        log.info("got policy enforcement event:" + event.action + ":" + event.policy.pid)
        if (this.queue) {
          const job = this.queue.createJob(event)
          job.timeout(60 * 1000).save((err) => {
            if (err) {
              log.error("Failed to create policy job", err.message);
              if (err.message && err.message.includes("NOSCRIPT")) {
                // this is usually caused by unexpected redis restart and previously loaded scripts are flushed
                log.info("Re-creating policy queue ...");
                this.queue.close(() => {
                  this.setupPolicyQueue().then(() => {
                    if (event.retry !== false) {
                      log.info("Retry policy job ...", event);
                      event.retry = false;
                      sem.emitEvent(event);
                    }
                  });
                });
              }
            }
          })
        }
      }
    })

    // deprecated
    sem.on("PolicySetDisableAll", async (event) => {
      await this.checkRunPolicies(false);
    })
  }

  tryPolicyEnforcement(policy, action, oldPolicy) {
    if (policy) {
      action = action || 'enforce'
      log.info("try policy enforcement:" + action + ":" + policy.pid)

      // invalidate ipset and active rules cache after policy update
      this.ipsetCache = null;
      this.sortedActiveRulesCache = null;
      this.sortedRoutesCache = null;

      sem.emitEvent({
        type: 'PolicyEnforcement',
        toProcess: 'FireMain',//make sure firemain process handle enforce policy event
        message: 'Policy Enforcement:' + action,
        action: action, //'enforce', 'unenforce', 'reenforce'
        policy: policy,
        oldPolicy: oldPolicy,
        suppressEventLogging: true,
      })
    }
  }

  async createPolicyIDKey() {
    await rclient.setAsync(policyIDKey, initID);
  }

  async getNextID() {
    return lock.acquire(LOCK_POLICY_ID, async () => {
      const prev = await rclient.getAsync(policyIDKey);
      if (prev) {
        while (true) {
          let next = await rclient.incrAsync(policyIDKey);
          if (next > POLICY_MAX_ID) {
            // wrap around
            await this.createPolicyIDKey();
            next = 1;
          }
          if (next === prev)
            throw new Error(`No free pid is available`);
          if (await rclient.existsAsync(`policy:${next}`))
            continue;
          return next;
        }
      } else {
        await this.createPolicyIDKey();
        return initID;
      }
    });
  }

  async addToActiveQueue(policy) {
    const score = parseFloat(policy.timestamp);
    const id = policy.pid;
    await rclient.zaddAsync(policyActiveKey, score, id);
  }

  // TODO: A better solution will be we always provide full policy data on calling this (requires mobile app update)
  // it's hard to keep sanity dealing with partial update and redis in the same time
  async updatePolicyAsync(policy) {
    if (!policy.pid)
      throw new Error("UpdatePolicyAsync requires policy ID");

    const policyKey = policyPrefix + policy.pid;

    if (policy instanceof Policy) {
      await rclient.hmsetAsync(policyKey, policy.redisfy());
      return;
    }

    let existing = await this.getPolicy(policy.pid);

    if (!existing)
      throw new Error("Policy not exist");

    let merged = new Policy(Object.assign({}, existing, policy));

    if (merged.target && merged.type) {
      switch (merged.type) {
        case "mac":
          merged.target = merged.target.toUpperCase(); // always upper case for mac address
          break;
        case "dns":
        case "domain":
          merged.target = merged.target.toLowerCase(); // always lower case for domain block
          break;
        default:
        // do nothing;
      }
    }

    await rclient.hmsetAsync(policyKey, merged.redisfy());

    const emptyStringCheckKeys = ["expire", "cronTime", "duration", "activatedTime", "remote", "remoteType", "local", "localType", "localPort", "remotePort", "proto", "parentRgId", "targetRgId"];

    for (const key of emptyStringCheckKeys) {
      if (!merged[key] || merged[key] === '')
        await rclient.hdelAsync(policyKey, key);
    }

    if (!merged.hasOwnProperty('scope') || _.isEmpty(merged.scope)) {
      await rclient.hdelAsync(policyKey, "scope");
    }
    if (!merged.hasOwnProperty('tag') || _.isEmpty(merged.tag)) {
      await rclient.hdelAsync(policyKey, "tag");
    }
    if (!merged.hasOwnProperty('guids') || _.isEmpty(merged.guids)) {
      await rclient.hdelAsync(policyKey, "guids");
    }
    if (!merged.hasOwnProperty('appTimeUsage') || _.isEmpty(merged.appTimeUsage)) {
      await rclient.hdelAsync(policyKey, "appTimeUsage");
    }
  }

  async savePolicyAsync(policy) {
    log.info("In save policy:", policy);
    const id = await this.getNextID();
    policy.pid = id + ""; // convert to string

    let policyKey = policyPrefix + id;
    await rclient.hmsetAsync(policyKey, policy.redisfy());
    await this.addToActiveQueue(policy);
    this.tryPolicyEnforcement(policy);
    Bone.submitIntelFeedback('block', policy).catch((err) => {
      log.error(`Failed to submit intel feedback`, policy, err);
    });
    return policy;
  }

  async checkAndSave(policy, callback) {
    callback = callback || function () { }
    if (!(policy instanceof Policy)) callback(new Error("Not Policy instance"));
    //FIXME: data inconsistence risk for multi-processes or multi-threads
    try {
      if (this.isFirewallaOrCloud(policy) && (policy.action || "block") === "block") {
        callback(new Error("To keep Firewalla Box running normally, Firewalla Box or Firewalla Cloud can't be blocked."));
        return
      }
      let policies = await this.getSamePolicies(policy)
      if (policies && policies.length > 0) {
        log.info("policy with type:" + policy.type + ",target:" + policy.target + " already existed")
        const samePolicy = policies[0]
        if (samePolicy.disabled && samePolicy.disabled == "1" && policy.disabled != "1") {
          // there is a policy in place and disabled, just need to enable it
          await this.enablePolicy(samePolicy)
          callback(null, samePolicy, "duplicated_and_updated")
        } else {
          callback(null, samePolicy, "duplicated")
        }
      } else {
        const data = await this.savePolicyAsync(policy);
        callback(null, data);
      }
    } catch (err) {
      log.error("failed to save policy:" + err)
      callback(err)
    }
  }

  checkAndSaveAsync(policy) {
    return new Promise((resolve, reject) => {
      this.checkAndSave(policy, (err, policy, alreadyExists) => {
        if (err) {
          reject(err)
        } else {
          resolve({ policy, alreadyExists })
        }
      })
    })
  }

  async policyExists(policyID) {
    const check = await rclient.existsAsync(policyPrefix + policyID)
    return check == 1
  }

  async getPolicy(policyID) {
    const results = await this.idsToPolicies([policyID])

    if (results == null || results.length === 0) {
      return null
    }

    return results[0]
  }

  async getSamePolicies(policy) {
    let policies = await this.loadActivePoliciesAsync({ includingDisabled: true });

    if (policies) {
      return policies.filter(p => policy.isEqual(p))
    }
  }

  // These two enable/disable functions are intended to be used by all nodejs processes, not just FireMain
  // So cross-process communication is used
  // the real execution is on FireMain, check out _enablePolicy and _disablePolicy below
  async enablePolicy(policy) {
    if (policy.disabled != '1') {
      return policy // do nothing, since it's already enabled
    }
    await this._enablePolicy(policy)

    if (await this.isDisableAll()) {
      return policy;  // temporarily by DisableAll flag
    }

    this.tryPolicyEnforcement(policy, "enforce")
    Bone.submitIntelFeedback('enable', policy)
    return policy
  }

  async disablePolicy(policy) {
    if (policy.disabled == '1') {
      return // do nothing, since it's already disabled
    }
    await this._disablePolicy(policy)
    this.tryPolicyEnforcement(policy, "unenforce")
    Bone.submitIntelFeedback('disable', policy)
  }

  async resetStats(policyIDs) {
    if (policyIDs && !Array.isArray(policyIDs))
      throw new Error('Invalid policy ID array', policyIDs)

    log.info("Trying to reset policy hit count:", policyIDs || 'all');

    const policyKeys = (policyIDs || await this.loadActivePolicyIDs()).map(this.getPolicyKey)
    const existingKeys = await batchKeyExists(policyKeys, 1500)

    for (const chunk of _.chunk(existingKeys, 1000)) {
      const resetTime = Math.round(Date.now() / 1000)
      const batch = rclient.batch() // we don't really need transaction here
      for (const key of chunk) {
        batch.hdel(key, "hitCount", "lastHitTs");
        batch.hset(key, "statsResetTs", resetTime);
      }
      await batch.execAsync()
    }
  }

  async getPoliciesByAction(actions) {
    if (_.isString(actions)) actions = [ actions ]
    const policies = await this.loadActivePoliciesAsync({includingDisabled : 1});
    const results = {}

    for (const p of policies) {
      const action = p.action || 'undefined'
      if (actions && !actions.includes(action)) continue
      if (!results[action]) results[action] = []

      results[action].push(p)
    }

    return results
  }

  async createInboundFirewallRule() {
    const policy = new Policy({
      action: 'block',
      direction: 'inbound',
      type: 'mac',
      method: 'auto',
    })
    return this.checkAndSaveAsync(policy)
  }

  async createActiveProtectRule() {
    const policy = new Policy({
      target: 'default_c',
      type: 'category',
      category: 'intel',
      method: 'auto',
    })
    await Block.setupCategoryEnv("default_c", "hash:net", 4096)
    return this.checkAndSaveAsync(policy)
  }

  async disableAndDeletePolicy(policyID) {
    if (!policyID) return;

    let policy = await this.getPolicy(policyID);

    if (!policy) {
      return;
    }

    await this.deletePolicy(policyID); // delete before broadcast

    this.tryPolicyEnforcement(policy, "unenforce")
    Bone.submitIntelFeedback('unblock', policy);
  }

  getPolicyKey(pid) {
    return policyPrefix + pid;
  }

  // for autoblock revalidation dry run only
  async markAsShouldDelete(policyID) {
    const policy = await this.getPolicy(policyID);

    if (!policy) {
      return;
    }

    return rclient.hsetAsync(this.getPolicyKey(policyID), "shouldDelete", "1");
  }

  async deletePolicy(policyID) {
    log.info("Trying to delete policy " + policyID);
    const exists = this.policyExists(policyID)
    if (!exists) {
      log.error("policy " + policyID + " doesn't exists");
      return
    }

    const multi = rclient.multi();
    multi.zrem(policyActiveKey, policyID);
    multi.unlink(policyPrefix + policyID);
    await multi.execAsync()
  }

  async deleteRuleGroupRelatedPolicies(uuid) {
    if (!uuid)
      return;
    let rules = await this.loadActivePoliciesAsync({ includingDisabled: 1 });
    const pidsToDelete = [];
    for (const rule of rules) {
      if (!rule.pid)
        continue;
      if (rule.parentRgId === uuid || rule.targetRgId === uuid)
        pidsToDelete.push(rule.pid);
    }
    for (const pid of pidsToDelete) {
      await this.disableAndDeletePolicy(pid);
    }
  }

  async deleteVpnClientRelatedPolicies(profileId) {
    const rules = await this.loadActivePoliciesAsync({ includingDisabled: 1 });
    const pidsToDelete = [];
    for (const rule of rules) {
      if (!rule.pid)
        continue;
      if (rule.wanUUID && rule.wanUUID === `${Block.VPN_CLIENT_WAN_PREFIX}${profileId}`)
        pidsToDelete.push(rule.pid);
      if (rule.owanUUID && rule.owanUUID === `${Block.VPN_CLIENT_WAN_PREFIX}${profileId}`)
        pidsToDelete.push(rule.pid);
    }
    for (const pid of pidsToDelete) {
      await this.disableAndDeletePolicy(pid);
    }
  }

  async deleteVirtWanGroupRelatedPolicies(profileId) {
    const rules = await this.loadActivePoliciesAsync({ includingDisabled: 1 });
    const pidsToDelete = [];
    for (const rule of rules) {
      if (!rule.pid)
        continue;
      if (rule.wanUUID && rule.wanUUID === `${Block.VIRT_WAN_GROUP_PREFIX}${profileId}`)
        pidsToDelete.push(rule.pid);
    }
    for (const pid of pidsToDelete) {
      await this.disableAndDeletePolicy(pid);
    }
  }

  // await all async opertions here to ensure errors are caught
  async deleteMacRelatedPolicies(mac) {
    let rules = await this.loadActivePoliciesAsync({ includingDisabled: 1 })
    let policyIds = [];
    let policyKeys = [];

    for (let rule of rules) {
      if (rule.type == 'mac' && rule.target == mac) {
        policyIds.push(rule.pid);
        policyKeys.push('policy:' + rule.pid);
        this.tryPolicyEnforcement(rule, 'unenforce');
        continue
      }

      if (!_.isEmpty(rule.scope) && rule.scope.some(m => m == mac)) {
        // rule targets only deleted device
        if (rule.scope.length <= 1) {
          policyIds.push(rule.pid);
          policyKeys.push('policy:' + rule.pid);

          this.tryPolicyEnforcement(rule, 'unenforce');
        }
        // rule targets NOT only deleted device
        else {
          let reducedScope = _.without(rule.scope, mac);
          await rclient.hsetAsync('policy:' + rule.pid, 'scope', JSON.stringify(reducedScope));
          const newRule = await this.getPolicy(rule.pid)

          this.tryPolicyEnforcement(newRule, 'reenforce', rule);

          log.info('remove scope from policy:' + rule.pid, mac);
        }
        continue;
      }

      if (rule.type === 'mac' && rule.guids && rule.guids[0] === mac) {
        policyIds.push(rule.pid);
        policyKeys.push('policy:' + rule.pid);
        this.tryPolicyEnforcement(rule, 'unenforce');
      }
    }

    if (policyIds.length) { // policyIds & policyKeys should have same length
      await rclient.unlinkAsync(policyKeys);
      await rclient.zremAsync(policyActiveKey, policyIds);
    }
    log.info('Deleted', mac, 'related policies:', policyKeys);
  }

  async deleteTagRelatedPolicies(tag) {
    // device specified policy
    await rclient.unlinkAsync('policy:tag:' + tag);

    let rules = await this.loadActivePoliciesAsync({ includingDisabled: 1 })
    let policyIds = [];
    let policyKeys = [];

    for (let rule of rules) {
      if (_.isEmpty(rule.tag) && rule.type !== "tag") continue;

      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const tagUid = Constants.TAG_TYPE_MAP[type].ruleTagPrefix + tag;
        if (_.isArray(rule.tag) && rule.tag.some(m => m == tagUid)) {
          if (rule.tag.length <= 1) {
            policyIds.push(rule.pid);
            policyKeys.push('policy:' + rule.pid);
  
            this.tryPolicyEnforcement(rule, 'unenforce');
          } else {
            let reducedTag = _.without(rule.tag, tagUid);
            await rclient.hsetAsync('policy:' + rule.pid, 'scope', JSON.stringify(reducedTag));
            const newRule = await this.getPolicy(rule.pid)
  
            this.tryPolicyEnforcement(newRule, 'reenforce', rule);
  
            log.info('remove scope from policy:' + rule.pid, tag);
          }
        }
      }
      if (rule.type === "tag" && rule.target == tag) {
        this.tryPolicyEnforcement(rule, 'unenforce');
        policyIds.push(rule.pid);
        policyKeys.push(`policy:${rule.pid}`);
      }  
    }

    if (policyIds.length) {
      await rclient.unlinkAsync(policyKeys);
      await rclient.zremAsync(policyActiveKey, policyIds);
    }
    log.info('Deleted', tag, 'related policies:', policyKeys);
  }

  async idsToPolicies(ids) {
    const multi = rclient.multi();

    ids.forEach((pid) => {
      multi.hgetall(policyPrefix + pid);
    });

    const results = await multi.execAsync()

    let rr = results
      .map(r => {
        if (!r) return null;

        let p = null;
        try {
          p = new Policy(r)
        } catch (e) {
          log.error(e, r);
        } finally {
          return p;
        }
      })
      .filter(r => r != null)

    // recent first
    rr.sort((a, b) => {
      return b.timestamp - a.timestamp
    })

    return rr
  }

  numberOfPolicies(callback) {
    callback = callback || function () { }

    rclient.zcount(policyActiveKey, "-inf", "+inf", (err, result) => {
      if (err) {
        callback(err);
        return;
      }

      // TODO: support more than 20 in the future
      callback(null, result > 20 ? 20 : result);
    });
  }

  async loadActivePolicyIDs(options = {}) {
    const number = options.number || policyCapacity;
    return rclient.zrevrangeAsync(policyActiveKey, 0, number - 1)
  }

  // we may need to limit number of policy rules created by user
  async loadActivePoliciesAsync(options = {}) {
    const results = await this.loadActivePolicyIDs(options)
    const policyRules = await this.idsToPolicies(results)
    if (options.includingDisabled) {
      return policyRules
    } else {
      return policyRules.filter(r => r.disabled != "1") // remove all disabled/idle ones
    }
  }

  async cleanActiveSet() {
    const IDs = await this.loadActivePolicyIDs()
    const keys = IDs.map(this.getPolicyKey)
    const existingKeys = await batchKeyExists(keys, 1000)

    const IDtoDel = _.difference(IDs, existingKeys.map(k => k.substring(7)))
    if (!IDtoDel.length) return

    log.info('Deleting none existing ID from active set:', IDtoDel)
    await rclient.zremAsync(policyActiveKey, IDtoDel)
  }

  // cleanup before use
  async cleanupPolicyData() {
    // await this.cleanActiveSet()
    await domainIPTool.removeAllDomainIPMapping()
    await tm.reset();
  }

  // split rules to routing rules, inbound rules, internet blocking rules, intranet blocking rules & others
  // these three are high impactful rules
  splitRules(rules) {
    let routeRules = [];
    // inbound block internet rules
    let inboundBlockInternetRules = [];
    // inbound allow internet rules
    let inboundAllowInternetRules = [];
    // inbound block intranet rules
    let inboundBlockIntranetRules = [];
    // inbound allow intranet rules
    let inboundAllowIntranetRules = [];
    // outbound/bidirection internet block rules
    let internetRules = [];
    // outbound/bidirection intranet block rules
    let intranetRules = [];
    // oubound/bidirection allow rules
    let outboundAllowRules = [];
    let otherRules = [];

    rules.forEach((rule) => {
      if (rule.isRouteRuleToVPN()) {
        routeRules.push(rule);
      } else if (rule.isInboundInternetBlockRule()) {
        inboundBlockInternetRules.push(rule);
      } else if (rule.isInboundInternetAllowRule()){
        inboundAllowInternetRules.push(rule);
      } else if (rule.isInboundIntranetBlockRule()) {
        inboundBlockIntranetRules.push(rule);
      } else if (rule.isInboundIntranetAllowRule()){
        inboundAllowIntranetRules.push(rule);
      } else if (rule.isBlockingInternetRule()) {
        internetRules.push(rule);
      } else if (rule.isBlockingIntranetRule()) {
        intranetRules.push(rule);
      } else if (rule.isOutboundAllowRule()) {
        outboundAllowRules.push(rule);
      } else {
        otherRules.push(rule);
      }
    });

    return [
      routeRules, 
      inboundBlockInternetRules, inboundAllowInternetRules,
      inboundBlockIntranetRules, inboundAllowIntranetRules,
      internetRules, intranetRules, 
      outboundAllowRules, otherRules,
    ];
  }

  async getHighImpactfulRules() {
    const policies = await this.loadActivePoliciesAsync();
    return policies.filter((x) => {
      return x.isRouteRuleToVPN() ||
      x.isBlockingInternetRule() ||
      x.isBlockingIntranetRule();
    });
  }

  async enforceAllPolicies() {
    const start = Date.now();
    const isReboot = await rclient.getAsync(Constants.REDIS_KEY_RUN_REBOOT) == "1";

    const rules = await this.loadActivePoliciesAsync({includingDisabled : 1});

    const [routeRules, inboundBlockInternetRules, inboundAllowInternetRules, inboundBlockIntranetRules, inboundAllowIntranetRules,
      internetRules, intranetRules, outboundAllowRules, otherRules] = this.splitRules(rules);

    let initialRuleJob = (rule) => {
      return new Promise((resolve, reject) => {
        try {
          if (this.queue) {
            const job = this.queue.createJob({
              policy: rule,
              action: "enforce",
              booting: true
            })
            job.timeout(60000).save();
            job.on('succeeded', resolve);
            job.on('failed', resolve);
          }
        } catch (err) {
          log.error(`Failed to queue policy ${rule.pid}`, err)
          resolve(err)
        }
      })
    };

    await Promise.all(routeRules.map((rule) => initialRuleJob(rule)));

    log.info(">>>>>==== All Hard ROUTING policy rules are enforced ====<<<<<", routeRules.length);

    // enforce policy rules in priority order:
    // inbound block (internet > intranet) > inbound allow (internet > intranet) > outbound/bidirection block (internet > intranet) > outbound allow > others

    // enforce inbound block internet rules
    await Promise.all(inboundBlockInternetRules.map((rule) => initialRuleJob(rule)));
    log.info(">>>>>==== All inbound blocking internet rules are enforced ====<<<<<", inboundBlockInternetRules.length);

    sem.sendEventToFireMain({
      type: Message.MSG_OSI_INBOUND_BLOCK_RULES_DONE,
      message: ""
    });

    // enforce inbound allow internet rules
    await Promise.all(inboundAllowInternetRules.map((rule) => initialRuleJob(rule)));
    log.info(">>>>>==== All inbound allow internet rules are enforced ====<<<<<", inboundAllowInternetRules.length);

    // enforce inbound block intranet rules
    await Promise.all(inboundBlockIntranetRules.map((rule) => initialRuleJob(rule)));
    log.info(">>>>>==== All inbound blocking intranet rules are enforced ====<<<<<", inboundBlockIntranetRules.length);

    // enforce inbound allow intranet rules
    await Promise.all(inboundAllowIntranetRules.map((rule) => initialRuleJob(rule)));
    log.info(">>>>>==== All inbound allow intranet rules are enforced ====<<<<<", inboundAllowIntranetRules.length);


    // enforce outbound block internet rules
    await Promise.all(internetRules.map((rule) => initialRuleJob(rule)));

    log.info(">>>>>==== All internet blocking rules are enforced ====<<<<<", internetRules.length);

    // enforce outbound block intranet rules
    await Promise.all(intranetRules.map((rule) => initialRuleJob(rule)));

    log.info(">>>>>==== All intranet blocking rules are enforced ====<<<<<", intranetRules.length);

    // enforce outbound allow intranet rules
    await Promise.all(outboundAllowRules.map((rule) => initialRuleJob(rule)));
    log.info(">>>>>==== All outbound allow rules are enforced ====<<<<<", outboundAllowRules.length);

    sem.sendEventToFireMain({
      type: Message.MSG_OSI_RULES_DONE,
      message: ""
    });

    const initialOtherEnforcement = otherRules.map((rule) => initialRuleJob(rule));
    await Promise.all(initialOtherEnforcement);

    log.forceInfo(">>>>>==== All policy rules are enforced ====<<<<<", otherRules.length);

    await rclient.setAsync(Constants.REDIS_KEY_POLICY_STATE, 'done')
    const end = Date.now();
    await rclient.setAsync(Constants.REDIS_KEY_POLICY_ENFORCE_SPENT, JSON.stringify({spend: (end-start)/1000, reboot: isReboot, ts: end/1000}));

    const event = {
      type: 'Policy:AllInitialized',
      message: 'All policies are enforced'
    }
    sem.sendEventToFireApi(event)
    sem.emitLocalEvent(event)
  }


  parseDevicePortRule(target) {
    let matches = target.match(/(.*):(\d+):(tcp|udp)/)
    if (matches) {
      let mac = matches[1];
      return {
        mac: mac,
        port: matches[2],
        protocol: matches[3]
      }
    } else {
      return null
    }
  }

  isFirewallaOrCloud(policy) {
    const target = policy.target
    if (!_.isString(target)) return false
    // target check is only applicable to IP/MAC address or domain
    if (policy.type && !["ip", "mac", "dns"].includes(policy.type)) return false
    return target && (sysManager.isMyServer(target) ||
      // sysManager.myIp() === target ||
      sysManager.isMyIP(target) ||
      sysManager.isMyMac(target) ||
      // compare mac, ignoring case
      sysManager.isMyMac(target.substring(0, 17)) || // devicePort policies have target like mac:protocol:prot
      isSameOrSubDomain(target, 'firewalla.encipher.io') ||
      target.endsWith('.firewalla.encipher.io') ||
      isSameOrSubDomain(target, 'firewalla.com') ||
      target.endsWith('.firewalla.com') ||
      isSameOrSubDomain(target, 'firewalla.net') ||
      target.endsWith('.firewalla.net')
    )
  }

  async enforce(policy) {
    try {
      if (await this.isDisableAll()) {
        return policy; // temporarily by DisableAll flag
      }
  
      if (policy.disabled == 1) {
        const idleInfo = policy.getIdleInfo();
        if (idleInfo) {
          const { idleTsFromNow, idleExpireSoon } = idleInfo;
          if (idleExpireSoon) {
            if (idleTsFromNow > 0)
              await delay(idleTsFromNow * 1000);
            await this.enablePolicy(policy);
            log.info(`Enable policy ${policy.pid} as it's idle already expired or expiring`);
          } else {
            const policyTimer = setTimeout(async () => {
              log.info(`Re-enable policy ${policy.pid} as it's idle expired`);
              await this.enablePolicy(policy).catch(err => log.error('Failed to enable policy', err));
            }, idleTsFromNow * 1000)
            this.invalidateExpireTimer(policy); // remove old one if exists
            this.enabledTimers[policy.pid] = policyTimer;
          }
        } else {
          // for now, expire (one-time only rule) and idleTs (pause for a specific time) won't co-exist in the same rule
          // so no need to consider timing between the two keys
          if (policy.expire) {
            const timeout = policy.getExpireDiffFromNow();
            if (policy.willExpireSoon()) {
              if (timeout > 0)
                await delay(timeout * 1000);
              if (policy.autoDeleteWhenExpires)
                await this.deletePolicy(policy.pid);
            } else {
              // only need to handle timeout of a manually disabled one-time only policy here
              // for a policy that is natually expired when enabled, it will be auto removed in another timeout created in enforce function
              if (timeout > 0 && policy.autoDeleteWhenExpires) {
                log.info(`Will auto delete paused policy ${policy.pid} in ${Math.floor(timeout)} seconds`);
                const deleteTimeout = setTimeout(async () => {
                  await this.deletePolicy(policy.pid);
                }, timeout * 1000);
                this.invalidateExpireTimer(policy); // remove old one if exists
                this.enabledTimers[policy.pid] = deleteTimeout;
              }
            }
          }
        }
        return // ignore disabled policy rules
      }
  
      // auto unenforce if expire time is set
      if (policy.expire) {
        if (policy.willExpireSoon()) {
          // skip enforce as it's already expired or expiring
          await delay(policy.getExpireDiffFromNow() * 1000);
          await this._disablePolicy(policy);
          if (policy.autoDeleteWhenExpires && policy.autoDeleteWhenExpires == "1") {
            await this.deletePolicy(policy.pid);
          }
          log.info(`Skip policy ${policy.pid} as it's already expired or expiring`)
        } else {
          this.notifyPolicyActivated(policy);
          await this._enforce(policy);
          log.info(`Will auto revoke policy ${policy.pid} in ${Math.floor(policy.getExpireDiffFromNow())} seconds`)
          const pid = policy.pid;
          const policyTimer = setTimeout(async () => {
            log.info(`About to revoke policy ${pid} `)
            // make sure policy is still enabled before disabling it
            const policy = await this.getPolicy(pid);
  
            // do not do anything if policy doesn't exist any more or it's disabled already
            if (!policy || policy.isDisabled()) {
              return
            }
  
            log.info(`Revoke policy ${policy.pid}, since it's expired`)
            await this.unenforce(policy);
            await this._disablePolicy(policy);
            if (policy.autoDeleteWhenExpires && policy.autoDeleteWhenExpires == "1") {
              await this.deletePolicy(pid);
            }
          }, policy.getExpireDiffFromNow() * 1000); // in milli seconds, will be set to 1 if it is a negative number
  
          this.invalidateExpireTimer(policy); // remove old one if exists
          this.enabledTimers[pid] = policyTimer;
        }
      } else if (policy.cronTime) {
        // this is a reoccuring policy, use scheduler to manage it
        return scheduler.registerPolicy(policy);
      } else if (policy.appTimeUsage) {
        // this is an app time usage policy, use AppTimeUsageManager to manage it
        return AppTimeUsageManager.registerPolicy(policy);
      } else {
        this.notifyPolicyActivated(policy);

        const action = policy.action || "block";
        const type = policy["i.type"] || policy["type"]; //backward compatibility
        if ((action === "block" || action === "app_block") && type === "category") {
          if (policy.dnsmasq_only && !policy.managedBy) {
            const tmpPolicy = Object.assign(Object.create(Policy.prototype), policy);
            tmpPolicy.dnsmasq_only = false;
            await this._enforce(tmpPolicy);

            let timeout = 600;
            if (policy.expire) {
              const policyTimeout = policy.getExpireDiffFromNow();
              if (policyTimeout < timeout) { // policy's expire time is less than 10 minutes donot change to domain block again.
                return;
              }
            } 
            this.domainBlockTimers[policy.pid] = {
              isTimerActive: true,
              domainBlockTimer: setTimeout(async () => {
                await this._unenforce(tmpPolicy);
                await this._enforce(policy);
                this.domainBlockTimers[policy.pid].isTimerActive = false;
              }, 600 * 1000)
            };
            return;
          }
        }
        await this._enforce(policy); // regular enforce
      }
    } finally {
      const action = policy.action || "block";
      if (action === "block" || action === "app_block")
        this.scheduleRefreshConnmark();
    }
  }

  // should be invoked right before the policy is effectively enforced, e.g., regular enforcement, schedule/pause until triggered
  notifyPolicyActivated(policy) {
    sem.emitLocalEvent({
      type: "Policy:Activated",
      policy
    });
  }

  // should be invoked right before the policy is effectively unenforced, e.g., regular unenforcement, end of schedule, one time only
  notifyPolicyDeactivated(policy) {
    sem.emitLocalEvent({
      type: "Policy:Deactivated",
      policy
    });
  }

  // this is the real execution of enable and disable policy
  async _enablePolicy(policy) {
    const now = new Date() / 1000
    await this.updatePolicyAsync({
      pid: policy.pid,
      disabled: 0,
      activatedTime: now,
      idleTs: ''
    })
    policy.disabled = 0
    policy.activatedTime = now
    log.info(`Policy ${policy.pid} is enabled`)
    return policy
  }

  async _disablePolicy(policy) {
    await this.updatePolicyAsync({
      pid: policy.pid,
      disabled: 1 // flag to indicate that this policy is revoked successfully.
    })
    policy.disabled = 1
    log.info(`Policy ${policy.pid} is disabled`)
    return policy
  }

  async _refreshActivatedTime(policy) {
    const now = new Date() / 1000
    let activatedTime = now;
    // retain previous activated time, this happens if policy is not deactivated normally, e.g., reboot, restart
    if (policy.activatedTime) {
      activatedTime = policy.activatedTime;
    }
    await this.updatePolicyAsync({
      pid: policy.pid,
      activatedTime: activatedTime
    })
    policy.activatedTime = activatedTime
    return policy
  }

  async _removeActivatedTime(policy) {

    const p = await this.getPolicy(policy.pid);

    if (!p) { // no need to update policy if policy is already deleted
      return;
    }

    await this.updatePolicyAsync({
      pid: policy.pid,
      activatedTime: ""
    })

    delete policy.activatedTime;
    return policy;
  }

  generateTaget(policy) {
    let { type, target, protocol, ip, net, port } = policy
    if (!_.isEmpty(target)) return target

    if (!_.isEmpty(ip) && !_.isArray(ip)) ip = [ip]
    if (!_.isEmpty(ip) && !_.isArray(net)) net = [net]
    if (!_.isEmpty(ip) && !_.isArray(port)) port = [port]

    switch (type) {
      case 'ip':
        return ip
      case 'net':
        return net
      case 'remotePort':
        return port
      case 'remoteIpPort': {
        let res = []
        for (const i of ip)
          for (const p of port)
            if (protocol)
              res.push(`${i},${protocol}:${p}`)
            else
              res.push(`${i}:${p}`)
        return res
      }
      case 'remoteNetPort': {
        let res = []
        for (const n of net)
          for (const p of port)
            if (protocol)
              res.push(`${n},${protocol}:${p}`)
            else
              res.push(`${n}:${p}`)
        return res
      }
    }
  }

  async parseTags(unsorted) {
    let intfs = [];
    let tags = [];
    if (!_.isEmpty(unsorted)) {
      for (const tagStr of unsorted) {
        if (tagStr.startsWith(Policy.INTF_PREFIX)) {
          const intfUuid = tagStr.substring(Policy.INTF_PREFIX.length);
          // do not check for interface validity here as some of them might not be ready during enforcement. e.g. VPN
          intfs.push(intfUuid);
        } else {
          for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
            const config = Constants.TAG_TYPE_MAP[type];
            if (tagStr.startsWith(config.ruleTagPrefix)) {
              const tagUid = tagStr.substring(config.ruleTagPrefix.length);
              const tagExists = await tagManager.tagUidExists(tagUid, type);
              if (tagExists) tags.push(tagUid);
            }
          }
        }
      }
    }
    tags = _.uniq(tags);

    return { intfs, tags }
  }


  async _enforce(policy) {
    log.info(`Enforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, action:${policy.action || "block"}`);

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    await this._refreshActivatedTime(policy)

    if (this.isFirewallaOrCloud(policy) && (policy.action || "block") === "block") {
      throw new Error("Firewalla and it's cloud service can't be blocked.")
    }

    // for now, targets is only used for multiple category block/app time limit
    let { pid, scope, target, targets, action = "block", tag, remotePort, localPort, protocol, direction, upnp, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, owanUUID, origDst, origDport, snatIP, routeType, guids, parentRgId, targetRgId, ipttl, resolver, flowIsolation, dscpClass } = policy;

    if (action === "app_block")
      action = "block"; // treat app_block same as block, but using a different term for version compatibility, otherwise, block rule will always take effect in previous versions

    if (!validActions.includes(action)) {
      log.error(`Unsupported action ${action} for policy ${pid}`);
      return;
    }

    const { intfs, tags } = await this.parseTags(tag)
    // invalid tag should not continue
    if (tag && tag.length && !tags.length && !intfs.length) {
      log.error(`Unknown policy tags format policy id: ${pid}, stop enforce policy`);
      return;
    }

    const security = policy.isSecurityBlockPolicy();
    const subPrio = this._getRuleSubPriority(type);

    const seq = policy.getSeq()

    let remoteSet4 = null;
    let remoteSet6 = null;
    let remoteSets = []; // only for multiple categories rule
    let localPortSet = null;
    let remotePortSet = null;
    let remotePositive = true;
    let remoteTupleCount = 1;
    let ctstate = null;
    let tlsHostSet = null;
    let tlsHostSets = []; // only for multiple categories rule
    let tlsHost = null;
    let skipFinalApplyRules = false;
    let qosHandler = null;
    if (localPort) {
      localPortSet = `c_bp_${pid}_local_port`;
      await ipset.create(localPortSet, "bitmap:port");
      await Block.batchBlock(localPort.split(","), localPortSet);
    }
    if (remotePort) {
      remotePortSet = `c_bp_${pid}_remote_port`;
      await ipset.create(remotePortSet, "bitmap:port");
      await Block.batchBlock(remotePort.split(","), remotePortSet);
    }

    if (upnp) {
      direction = "inbound";
      ctstate = "DNAT";
    }

    if (action === "qos") {
      qosHandler = await qos.allocateQoSHanderForPolicy(pid);
    }

    switch (type) {
      case "ip":

        if (action === "allow" && policy.trust) {
          await tm.addIP(target);
        }

      case "net": {
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || !_.isEmpty(guids) || parentRgId || localPortSet || remotePortSet || owanUUID || origDst || origDport || action === "qos" || action === "route" || action === "alarm" || action === "snat" || (seq !== Constants.RULE_SEQ_REG && !security)) {
          await ipset.create(remoteSet4, ruleSetTypeMap[type]);
          await ipset.create(remoteSet6, ruleSetTypeMap[type], true);
          await Block.block(target, Block.getDstSet(pid));
        } else {
          if (["allow", "block"].includes(action)) {
            // apply to global without specified src/dst port, directly add to global ip or net allow/block set
            const set = (security ? 'sec_' : '')
              + (action === "allow" ? 'allow_' : 'block_')
              + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : ""))
              + simpleRuleSetMap[type];
            // Block.block will distribute IPv4/IPv6 to corresponding ipset, additional '6' will be added to set name for IPv6 ipset
            await Block.block(target, set);
            return;
          }
        }
        break;
      }
      case "remotePort":
        remotePort = target;
      case "remoteIpPort":
      case "remoteNetPort": {
        const values = (target && target.split(',')) || [];
        if (values.length == 2 && (type === "remoteIpPort" || type === "remoteNetPort")) {
          // ip,port or net,port
          if (type === "remoteIpPort") {
            remoteSet4 = Block.getDstSet(pid);
            remoteSet6 = Block.getDstSet6(pid);
            await ipset.create(remoteSet4, "hash:ip");
            await ipset.create(remoteSet6, "hash:ip", true);
          }
          if (type === "remoteNetPort") {
            remoteSet4 = Block.getDstSet(pid);
            remoteSet6 = Block.getDstSet6(pid);
            await ipset.create(remoteSet4, "hash:net");
            await ipset.create(remoteSet6, "hash:net", true);
          }
          await Block.block(values[0], Block.getDstSet(pid));
          remotePort = values[1];
        }

        if (remotePort) {
          remotePortSet = `c_bp_${pid}_remote_port`;
          await ipset.create(remotePortSet, "bitmap:port");
          await Block.batchBlock(remotePort.split(","), remotePortSet);
        }
        break;
      }
      case "mac":
      case "internet": // mac is the alias of internet
        remoteSet4 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remoteSet6 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remotePositive = false;
        remoteTupleCount = 2;
        // legacy data format
        // target: "TAG" is a placeholder for various rules from App
        if (target && ht.isMacAddress(target)) {
          scope = [target];
        }
        if (["allow", "block", "resolve", "address", "route"].includes(action)) {
          if (direction !== "inbound" && !localPort && !remotePort) {
            const scheduling = policy.isSchedulingPolicy();
            if (action != "block" || policy.dnsmasq_only) { // dnsmasq_only + block indicates if DNS block should be applied on internet block
              // empty string matches all domains
              await dnsmasq.addPolicyFilterEntry([""], { pid, scope, intfs, tags, guids, action, parentRgId, seq, scheduling, resolver, wanUUID, routeType }).catch(() => { });
              dnsmasq.scheduleRestartDNSService();
            }
          }
        }
        if (action === "resolve" || action === "address") // no further action is needed for resolve rule
          return;
        break;
      case "domain":
      case "dns":
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);

        if (platform.isTLSBlockSupport()) { // default on
          if (!policy.domainExactMatch && !target.startsWith("*."))
            tlsHost = `*.${target}`;
          else
            tlsHost = target;
        }

        if (action === "allow" && policy.trust) {
          const finalTarget = (policy.domainExactMatch || target.startsWith("*.")) ? target : `*.${target}`;
          await tm.addDomain(finalTarget);
        }

        if (["allow", "block", "resolve", "address", "route"].includes(action)) {
          if (direction !== "inbound" && (action === "allow" || !localPort && !remotePort)) { // always implement allow rule in dnsmasq, but implement block rule only in iptables
            const scheduling = policy.isSchedulingPolicy();
            const exactMatch = policy.domainExactMatch;
            const flag = await dnsmasq.addPolicyFilterEntry([target], { pid, scope, intfs, tags, guids, action, parentRgId, seq, scheduling, exactMatch, resolver, wanUUID, routeType }).catch(() => { });
            if (flag !== "skip_restart") {
              dnsmasq.scheduleRestartDNSService();
            }
          }
          if (policy.dnsmasq_only) {
            skipFinalApplyRules = true;
          }
        }
        if (action === "resolve" || action == "address") // no further action is needed for pure dns rule
          return;

        if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || !_.isEmpty(guids) || parentRgId || localPortSet || remotePortSet || owanUUID || origDst || origDport || action === "qos" || action === "route" || action === "alarm" || action === "snat" || Number.isInteger(ipttl) || (seq !== Constants.RULE_SEQ_REG && !security)) {
          if (!policy.dnsmasq_only) {
            await ipset.create(remoteSet4, "hash:ip", false, { timeout: ipttl });
            await ipset.create(remoteSet6, "hash:ip", true, { timeout: ipttl });
            // register ipset update in dnsmasq config so that it will immediately take effect in ip level
            await dnsmasq.addIpsetUpdateEntry([target], [remoteSet4, remoteSet6], pid);
            dnsmasq.scheduleRestartDNSService();
          }
          await domainBlock.blockDomain(target, {
            noIpsetUpdate: policy.dnsmasq_only ? true : false,
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(pid),
            ipttl: ipttl
          });
        } else {
          if (["allow", "block"].includes(action)) {
            const set = (security ? 'sec_' : '')
              + (action === "allow" ? 'allow_' : 'block_')
              + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : ""))
              + simpleRuleSetMap[type];
            tlsHostSet = (security ? 'sec_' : '') + (action === "allow" ? 'allow_' : 'block_') + "domain_set";
            await domainBlock.blockDomain(target, {
              noIpsetUpdate: policy.dnsmasq_only ? true : false,
              exactMatch: policy.domainExactMatch,
              blockSet: set,
              tlsHostSet: tlsHostSet
            });
            if (!policy.dnsmasq_only) {
              await dnsmasq.addIpsetUpdateEntry([target], [set, `${set}6`], pid);
              dnsmasq.scheduleRestartDNSService();
            }
            if (policy.blockby == 'fastdns') {
              sem.emitEvent({
                type: 'FastDNSPolicyComplete',
                domain: target
              })
            }
            return;
          }
        }
        break;

      case "domain_re":
        if (["block", "resolve"].includes(action)) {
          if (direction !== "inbound" && !localPort && !remotePort) {
            if (this.checkValidDomainRE(target)) {
              const scheduling = policy.isSchedulingPolicy();
              const matchType = "re";
              const flag = await dnsmasq.addPolicyFilterEntry([target], { pid, scope, intfs, tags, guids, action, parentRgId, seq, scheduling, resolver, matchType }).catch(() => { });
              if (flag !== "skip_restart") {
                dnsmasq.scheduleRestartDNSService();
              }
            } else {
              log.error("Invalid domain regular expression", target);
              return;
            }
          } else {
            log.error("Port not supported on domain RE");
            return;
          }
        } else {
          log.error("Only block and resolve actions are supported by domain_re type");
          return;
        }

        skipFinalApplyRules = true;
        tlsHost = null;
        break;

      // target format host:mac:proto, ONLY support single host
      // do not support scope || tags || intfs
      case "devicePort": {
        let data = this.parseDevicePortRule(target);
        if (data && data.mac) {
          protocol = data.protocol;
          localPort = data.port;
          scope = [data.mac];

          if (localPort) {
            localPortSet = `c_bp_${pid}_local_port`;
            await ipset.create(localPortSet, "bitmap:port");
            await Block.batchBlock(localPort.split(","), localPortSet);
          } else
            return;
        } else
          return;
        break;
      }

      case "category":
        if (_.isEmpty(targets))
          targets = [target];
        if (platform.isTLSBlockSupport()) { // default on
          for (const target of targets)
            tlsHostSets.push(categoryUpdater.getHostSetName(target));
        }

        if (["allow", "block", "route"].includes(action)) {
          if (direction !== "inbound" && (action === "allow" || !localPort && !remotePort)) {
            await domainBlock.blockCategory({
              pid,
              scope: scope,
              categories: targets,
              intfs,
              guids,
              action: action,
              tags,
              parentRgId,
              seq,
              wanUUID,
              routeType
            });
            if (policy.useBf) {
              await domainBlock.blockCategory({pid,
                scope: scope, categories: targets.map(target => target + "_bf"), intfs, guids,
                action: action, tags, parentRgId, seq, wanUUID, routeType, append: true
              });
            }
          }
        }

        for (const target of targets) {
          await categoryUpdater.activateCategory(target);
          if (policy.useBf) {
            await categoryUpdater.activateCategory(target + '_bf');
          }

          if (action === "allow") {
            remoteSets.push({
              remoteSet4: categoryUpdater.getAllowIPSetName(target),
              remoteSet6: categoryUpdater.getAllowIPSetNameForIPV6(target)
            });
          } else if (policy.dnsmasq_only) {
            // only use static ipset if dnsmasq_only is set
            remoteSets.push({
              remoteSet4: categoryUpdater.getAggrIPSetName(target, true),
              remoteSet6: categoryUpdater.getAggrIPSetNameForIPV6(target, true)
            });
          } else {
            remoteSets.push({
              remoteSet4: categoryUpdater.getAggrIPSetName(target),
              remoteSet6: categoryUpdater.getAggrIPSetNameForIPV6(target)
            });
          }
        }
        remoteTupleCount = 2;
        break;

      case "country":
        if (_.isEmpty(targets))
          targets = [target];
        for (const target of targets) {
          await countryUpdater.activateCountry(target);
          remoteSets.push({
            remoteSet4: countryUpdater.getIPSetName(countryUpdater.getCategory(target)),
            remoteSet6: countryUpdater.getIPSetNameForIPV6(countryUpdater.getCategory(target))
          });
        }
        break;

      case "intranet":
        remoteSet4 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remoteSet6 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remoteTupleCount = 2;
        break;

      case "network":
        // target is network uuid
        await NetworkProfile.ensureCreateEnforcementEnv(target);
        remoteSet4 = NetworkProfile.getNetIpsetName(target, 4);
        remoteSet6 = NetworkProfile.getNetIpsetName(target, 6);
        remoteTupleCount = 2;
        break;

      case "tag":
        // target is tag uid
        await Tag.ensureCreateEnforcementEnv(target);
        remoteSet4 = Tag.getTagSetName(target);
        remoteSet6 = Tag.getTagSetName(target);
        remoteTupleCount = 2;
        break;

      case "device":
        if (ht.isMacAddress(target)) {
          // target is device mac address
          await Host.ensureCreateEnforcementEnv(target);
          remoteSet4 = Host.getDeviceSetName(target);
          remoteSet6 = Host.getDeviceSetName(target);
        } else {
          const c = IdentityManager.getIdentityClassByGUID(target);
          if (c) {
            const { ns, uid } = IdentityManager.getNSAndUID(target);
            await c.ensureCreateEnforcementEnv(uid);
            remoteSet4 = c.getEnforcementIPsetName(uid, 4);
            remoteSet6 = c.getEnforcementIPsetName(uid, 6);
          } else {
            log.error(`Unrecognized device target: ${target}`);
            return;
          }
        }
        
        break;

      case "match_group":
        action = "match_group";
        break;
      default:
        throw new Error("Unsupported policy type");
    }

    if (action === "match_group") {
      // add rule group link in dnsmasq config
      await dnsmasq.linkRuleToRuleGroup({ scope, intfs, tags, guids, pid }, targetRgId);
      dnsmasq.scheduleRestartDNSService();
    }

    const commonOptions = {
      pid, tags, intfs, scope, guids, parentRgId,
      localPortSet, /*remoteSet4, remoteSet6,*/ remoteTupleCount, remotePositive, remotePortSet, proto: protocol,
      action, direction, createOrDestroy: "create", ctstate,
      trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
      wanUUID, security, targetRgId, seq, // tlsHostSet, tlsHost,
      subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass
    }
    if (tlsHostSet || tlsHost || !_.isEmpty(tlsHostSets)) {
      let tlsInstalled = true;
      await platform.installTLSModules().catch((err) => {
        log.error(`Failed to install TLS module, will not apply rule ${pid} based on tls`, err.message);
        tlsInstalled = false;
      })

      if (tlsInstalled) {
        // no need to specify remote set 4 & 6 for tls block\
        if (!_.isEmpty(tlsHostSets)) {
          for (const tlsHostSet of tlsHostSets) {
            await this.__applyTlsRules({ ...commonOptions, tlsHostSet, tlsHost }).catch((err) => {
              log.error(`Failed to enforce rule ${pid} based on tls`, err.message);
            });
          }
          // activate TLS category after rule is added in iptables, this can guarante hostset is generated in /proc filesystem
          if (!_.isEmpty(targets)) {
            for (const target of targets)
              await categoryUpdater.activateTLSCategory(target);
          }
        } else {
          await this.__applyTlsRules({ ...commonOptions, tlsHostSet, tlsHost }).catch((err) => {
            log.error(`Failed to enforce rule ${pid} based on tls`, err.message);
          });
          // activate TLS category after rule is added in iptables, this can guarante hostset is generated in /proc filesystem
          if (tlsHostSet)
            await categoryUpdater.activateTLSCategory(target);
        }
      }
    }

    if (skipFinalApplyRules) {
      return;
    }

    if (!_.isEmpty(remoteSets)) {
      for (const {remoteSet4, remoteSet6} of remoteSets) {
        await this.__applyRules({ ...commonOptions, remoteSet4, remoteSet6 }).catch((err) => {
          log.error(`Failed to enforce rule ${pid} based on ip`, err.message);
        });    
      }
    } else {
      await this.__applyRules({ ...commonOptions, remoteSet4, remoteSet6 }).catch((err) => {
        log.error(`Failed to enforce rule ${pid} based on ip`, err.message);
      });
    }
  }

  async __applyRules(options) {
    const { tags, intfs, scope, guids, parentRgId } = options || {};
    const ruleOptions = _.omit(options, 'tags', 'intfs', 'scope', 'guids', 'parentRgId')

    if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || !_.isEmpty(guids) || !_.isEmpty(parentRgId)) {
      if (!_.isEmpty(tags))
        await Block.setupTagsRules({ ...ruleOptions, uids: tags });
      if (!_.isEmpty(intfs))
        await Block.setupIntfsRules({ ...ruleOptions, uuids: intfs });
      if (!_.isEmpty(scope))
        await Block.setupDevicesRules({ ...ruleOptions, macAddresses: scope });
      if (!_.isEmpty(guids))
        await Block.setupGenericIdentitiesRules({ ...ruleOptions, guids });
      if (!_.isEmpty(parentRgId))
        await Block.setupRuleGroupRules({ ...ruleOptions, ruleGroupUUID: parentRgId });
    } else {
      // apply to global
      await Block.setupGlobalRules(ruleOptions);
    }
  }

  async __applyTlsRules(options) {
    const { proto } = options;

    if (proto === "tcp" || proto === "udp") {
      await this.__applyRules(options);
    } else if (!proto) {
      for (const proto of ["tcp", "udp"]) {
        await this.__applyRules({ ...options, proto });
      }
    }
  }

  invalidateExpireTimer(policy) {
    const pid = policy.pid
    if (this.enabledTimers[pid]) {
      log.info("Invalidate expire timer for policy", pid);
      clearTimeout(this.enabledTimers[pid])
      delete this.enabledTimers[pid]
    }
  }

  unenforce(policy) {
    try {
      this.invalidateExpireTimer(policy) // invalidate timer if exists
      if (policy.cronTime) {
        // this is a reoccuring policy, use scheduler to manage it
        return scheduler.deregisterPolicy(policy)
      } else if (policy.appTimeUsage) {
        // this is an app time usage policy, use AppTimeUsageManager to manage it
        return AppTimeUsageManager.deregisterPolicy(policy);
      } else {
        this.notifyPolicyDeactivated(policy);
        if (this.domainBlockTimers[policy.pid]) {
          const isTimerActive = this.domainBlockTimers[policy.pid].isTimerActive;
          clearTimeout(this.domainBlockTimers[policy.pid].domainBlockTimer);
          delete this.domainBlockTimers[policy.pid];
          if (isTimerActive) { // domain block timer is still running
            const tmpPolicy = Object.assign(Object.create(Policy.prototype), policy);
            tmpPolicy.dnsmasq_only = false;
            return this._unenforce(tmpPolicy) // unenforce with dnsmasq_only=false
          }
        }
        return this._unenforce(policy) // regular unenforce
      }
    } finally {
      if (policy.action === "allow")
        this.scheduleRefreshConnmark();
    }
  }

  async _unenforce(policy) {
    log.info(`Unenforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, action:${policy.action || "block"}`);

    await this._removeActivatedTime(policy)

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    let { pid, scope, target, targets, action = "block", tag, remotePort, localPort, protocol, direction, upnp, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, owanUUID, origDst, origDport, snatIP, routeType, guids, parentRgId, targetRgId, resolver, flowIsolation, dscpClass } = policy;

    if (action === "app_block")
      action = "block";

    if (!validActions.includes(action)) {
      log.error(`Unsupported action ${action} for policy ${pid}`);
      return;
    }

    const { intfs, tags } = await this.parseTags(tag)
    // invalid tag should not continue
    if (tag && tag.length && !tags.length && !intfs.length) {
      log.error(`Unknown policy tags format policy id: ${pid}, stop unenforce policy`);
      return;
    }

    const security = policy.isSecurityBlockPolicy();
    const subPrio = this._getRuleSubPriority(type);

    const seq = policy.getSeq()

    let remoteSet4 = null;
    let remoteSet6 = null;
    let remoteSets = []; // only for multiple categories rule
    let localPortSet = null;
    let remotePortSet = null;
    let remotePositive = true;
    let remoteTupleCount = 1;
    let ctstate = null;
    let tlsHostSet = null;
    let tlsHostSets = []; // only for multiple categories rule
    let tlsHost = null;
    let qosHandler = null;
    if (localPort) {
      localPortSet = `c_bp_${pid}_local_port`;
      await Block.batchUnblock(localPort.split(","), localPortSet);
    }
    if (remotePort) {
      remotePortSet = `c_bp_${pid}_remote_port`;
      await Block.batchUnblock(remotePort.split(","), remotePortSet);
    }

    if (upnp) {
      direction = "inbound";
      ctstate = "DNAT";
    }

    if (action === "qos")
      qosHandler = await qos.getQoSHandlerForPolicy(pid);

    switch (type) {
      case "ip":

        if (action === "allow" && policy.trust) {
          await tm.removeIP(target);
        }

      case "net": {
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || !_.isEmpty(guids) || parentRgId || localPortSet || remotePortSet || owanUUID || origDst || origDport || action === "qos" || action === "route" || action === "alarm" || action == "snat" || (seq !== Constants.RULE_SEQ_REG && !security)) {
          await Block.unblock(target, Block.getDstSet(pid));
        } else {
          if (["allow", "block"].includes(action)) {
            const set = (security ? 'sec_' : '')
              + (action === "allow" ? 'allow_' : 'block_')
              + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : ""))
              + simpleRuleSetMap[type];
            await Block.unblock(target, set);
            return;
          }
        }
        break;
      }
      case "remotePort":
        remotePort = target;
      case "remoteIpPort":
      case "remoteNetPort": {
        const values = (target && target.split(',')) || [];
        if (values.length == 2 && (type === "remoteIpPort" || type === "remoteNetPort")) {
          // ip,port or net,port
          if (type === "remoteIpPort") {
            remoteSet4 = Block.getDstSet(pid);
            remoteSet6 = Block.getDstSet6(pid);
            await ipset.create(remoteSet4, "hash:ip");
            await ipset.create(remoteSet6, "hash:ip", true);
          }
          if (type === "remoteNetPort") {
            remoteSet4 = Block.getDstSet(pid);
            remoteSet6 = Block.getDstSet6(pid);
            await ipset.create(remoteSet4, "hash:net");
            await ipset.create(remoteSet6, "hash:net", true);
          }
          await Block.block(values[0], Block.getDstSet(pid));
          remotePort = values[1];
        }

        if (remotePort) {
          remotePortSet = `c_bp_${pid}_remote_port`;
          await Block.batchUnblock(remotePort.split(","), remotePortSet);
        }
        break;
      }
      case "mac":
      case "internet":
        remoteSet4 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remoteSet6 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remotePositive = false;
        remoteTupleCount = 2;
        // legacy data format
        if (target && ht.isMacAddress(target)) {
          scope = [target];
        }
        if (["allow", "block", "resolve", "address", "route"].includes(action)) {
          if (direction !== "inbound" && !localPort && !remotePort) {
            const scheduling = policy.isSchedulingPolicy();
            // empty string matches all domains
            await dnsmasq.removePolicyFilterEntry([""], { pid, scope, intfs, tags, guids, action, parentRgId, seq, scheduling, resolver, wanUUID, routeType }).catch(() => { });
            dnsmasq.scheduleRestartDNSService();
          }
        }
        if (action === "resolve" || action === "address") // no further action is needed for pure dns rule
          return;
        break;
      case "domain":
      case "dns":
        if (platform.isTLSBlockSupport()) { // default on
          if (!policy.domainExactMatch && !target.startsWith("*."))
            tlsHost = `*.${target}`;
          else
            tlsHost = target;
        }

        if (action === "allow" && policy.trust) {
          const finalTarget = (policy.domainExactMatch || target.startsWith("*.")) ? target : `*.${target}`;
          await tm.removeDomain(finalTarget);
        }

        if (!policy.dnsmasq_only) {
          await dnsmasq.removeIpsetUpdateEntry(pid);
          dnsmasq.scheduleRestartDNSService();
        }

        if (["allow", "block", "resolve", "address", "route"].includes(action)) {
          if (direction !== "inbound" && (action === "allow" || !localPort && !remotePort)) {
            const scheduling = policy.isSchedulingPolicy();
            const exactMatch = policy.domainExactMatch;
            const flag = await dnsmasq.removePolicyFilterEntry([target], { pid, scope, intfs, tags, guids, action, parentRgId, seq, scheduling, exactMatch, resolver, wanUUID, routeType }).catch(() => { });
            if (flag !== "skip_restart") {
              dnsmasq.scheduleRestartDNSService();
            }
          }
        }
        if (action === "resolve" || action === "address") // no further action is needed for pure dns rule
          return;
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(scope) || !_.isEmpty(intfs) || !_.isEmpty(guids) || parentRgId || localPortSet || remotePortSet || owanUUID || origDst || origDport || action === "qos" || action === "route" || action === "alarm" || action == "snat" || (seq !== Constants.RULE_SEQ_REG && !security)) {
          await domainBlock.unblockDomain(target, {
            noIpsetUpdate: policy.dnsmasq_only ? true : false,
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(pid)
          });
        } else {
          if (["allow", "block"].includes(action)) {
            const set = (security ? 'sec_' : '')
              + (action === "allow" ? 'allow_' : 'block_')
              + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : ""))
              + simpleRuleSetMap[type];
            tlsHostSet = (security ? 'sec_' : '') + (action === "allow" ? 'allow_' : 'block_') + "domain_set";
            await domainBlock.unblockDomain(target, {
              exactMatch: policy.domainExactMatch,
              blockSet: set,
              tlsHostSet: tlsHostSet
            });
            return;
          }
        }
        break;

      case "domain_re": {
        if (["block", "resolve"].includes(action)) {
          if (direction !== "inbound" && !localPort && !remotePort) {
            if (this.checkValidDomainRE(target)) {
              const scheduling = policy.isSchedulingPolicy();
              const matchType = "re";
              const flag = await dnsmasq.removePolicyFilterEntry([target], { pid, scope, intfs, tags, guids, action, parentRgId, seq, scheduling, resolver, matchType }).catch(() => { });
              if (flag !== "skip_restart") {
                dnsmasq.scheduleRestartDNSService();
              }
            } else {
              log.error("Invalid domain regular expression", target);
              return;
            }
          } else {
            log.error("Port not supported on domain RE", target);
            return;
          }
        } else {
          log.error("Only block and resolve actions are supported by domain_re type");
          return;
        }
        break;
      }

      case "devicePort": {
        let data = this.parseDevicePortRule(target)
        if (data && data.mac) {
          protocol = data.protocol;
          localPort = data.port;
          scope = [data.mac];

          if (localPort) {
            localPortSet = `c_bp_${pid}_local_port`;
            await Block.batchUnblock(localPort.split(","), localPortSet);
          } else
            return;
        } else
          return;
        break;
      }

      case "category":
        if (_.isEmpty(targets))
          targets = [target];
        if (platform.isTLSBlockSupport()) { // default on
          for (const target of targets)
            tlsHostSets.push(categoryUpdater.getHostSetName(target));
        }

        if (["allow", "block", "route"].includes(action)) {
          if (direction !== "inbound" && (action === "allow" || !localPort && !remotePort)) {
            await domainBlock.unblockCategory({
              pid,
              action,
              scope: scope,
              categories: targets,
              intfs,
              tags,
              guids,
              parentRgId,
              seq,
              wanUUID,
              routeType
            });
          }
        }
        for (const target of targets) {
          if (action === "allow") {
            remoteSets.push({
              remoteSet4: categoryUpdater.getAllowIPSetName(target),
              remoteSet6: categoryUpdater.getAllowIPSetNameForIPV6(target)
            });
          } else if (policy.dnsmasq_only) {
            // only use static ipset if dnsmasq_only is set
            remoteSets.push({
              remoteSet4: categoryUpdater.getAggrIPSetName(target, true),
              remoteSet6: categoryUpdater.getAggrIPSetNameForIPV6(target, true)
            });
          } else {
            remoteSets.push({
              remoteSet4: categoryUpdater.getAggrIPSetName(target),
              remoteSet6: categoryUpdater.getAggrIPSetNameForIPV6(target)
            });
          }
        }
        remoteTupleCount = 2;
        break;

      case "country":
        if (_.isEmpty(targets))
          targets = [target];
        for (const target of targets) {
          remoteSets.push({
            remoteSet4: countryUpdater.getIPSetName(countryUpdater.getCategory(target)),
            remoteSet6: countryUpdater.getIPSetNameForIPV6(countryUpdater.getCategory(target))
          });
        }
        break;

      case "intranet":
        remoteSet4 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remoteSet6 = ipset.CONSTANTS.IPSET_MONITORED_NET;
        remoteTupleCount = 2;
        break;

      case "network":
        // target is network uuid
        await NetworkProfile.ensureCreateEnforcementEnv(target);
        remoteSet4 = NetworkProfile.getNetIpsetName(target, 4);
        remoteSet6 = NetworkProfile.getNetIpsetName(target, 6);
        remoteTupleCount = 2;
        break;

      case "tag":
        // target is tag uid
        await Tag.ensureCreateEnforcementEnv(target);
        remoteSet4 = Tag.getTagSetName(target);
        remoteSet6 = Tag.getTagSetName(target);
        remoteTupleCount = 2;
        break;

      case "device":
        if (ht.isMacAddress(target)) {
          // target is device mac address
          await Host.ensureCreateEnforcementEnv(target);
          remoteSet4 = Host.getDeviceSetName(target);
          remoteSet6 = Host.getDeviceSetName(target);
        } else {
          const c = IdentityManager.getIdentityClassByGUID(target);
          if (c) {
            const { ns, uid } = IdentityManager.getNSAndUID(target);
            await c.ensureCreateEnforcementEnv(uid);
            remoteSet4 = c.getEnforcementIPsetName(uid, 4);
            remoteSet6 = c.getEnforcementIPsetName(uid, 6);
          } else {
            log.error(`Unrecognized device target: ${target}`);
            return;
          }
        }
        break;

      case "match_group":
        action = "match_group";
        break;
      default:
        throw new Error("Unsupported policy");
    }

    if (action === "match_group") {
      // remove rule group link in dnsmasq config
      await dnsmasq.unlinkRuleFromRuleGroup({ scope, intfs, tags, guids, pid }, targetRgId);
      dnsmasq.scheduleRestartDNSService();
    }

    const commonOptions = {
      pid, tags, intfs, scope, guids, parentRgId,
      localPortSet, /*remoteSet4, remoteSet6,*/ remoteTupleCount, remotePositive, remotePortSet, proto: protocol,
      action, direction, createOrDestroy: "destroy", ctstate,
      trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
      wanUUID, security, targetRgId, seq, // tlsHostSet, tlsHost,
      subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass
    }
    if (!_.isEmpty(remoteSets)) {
      for (const setPair of remoteSets) {
        await this.__applyRules(Object.assign(setPair, commonOptions)).catch((err) => {
          log.error(`Failed to unenforce rule ${pid} based on ip`, err.message);
        });    
      }
    } else {
      await this.__applyRules(Object.assign({ remoteSet4, remoteSet6 }, commonOptions)).catch((err) => {
        log.error(`Failed to unenforce rule ${pid} based on ip`, err.message);
      });
    }

    if (tlsHostSet || tlsHost || !_.isEmpty(tlsHostSets)) {
      if (!_.isEmpty(tlsHostSets)) {
        for (const tlsHostSet of tlsHostSets) {
          await this.__applyTlsRules({ ...commonOptions, tlsHostSet, tlsHost }).catch((err) => {
            log.error(`Failed to unenforce rule ${pid} based on tls`, err.message);
          });
        }
      } else {
        await this.__applyTlsRules({ ...commonOptions, tlsHostSet, tlsHost }).catch((err) => {
          log.error(`Failed to unenforce rule ${pid} based on tls`, err.message);
        });
      }
      // refresh activated tls category after rule is removed from iptables, hostset in /proc filesystem will be removed after last reference in iptables rule is removed
      if (tlsHostSet || !_.isEmpty(tlsHostSets)) {
        await delay(200); // wait for 200 ms so that hostset file can be purged from proc fs
        await categoryUpdater.refreshTLSCategoryActivated();
      }
    }

    if (localPortSet) {
      await ipset.flush(localPortSet);
      await ipset.destroy(localPortSet);
    }
    if (remotePortSet) {
      await ipset.flush(remotePortSet);
      await ipset.destroy(remotePortSet);
    }
    if (remoteSet4) {
      if (type === "ip" || type === "net" || type === "remoteIpPort" || type === "remoteNetPort" || type === "domain" || type === "dns") {
        if (!policy.dnsmasq_only) {
          await ipset.flush(remoteSet4);
          await ipset.destroy(remoteSet4);
        }
      }
    }
    if (remoteSet6) {
      if (type === "ip" || type === "net" || type === "remoteIpPort" || type === "remoteNetPort" || type === "domain" || type === "dns") {
        if (!policy.dnsmasq_only) {
          await ipset.flush(remoteSet6);
          await ipset.destroy(remoteSet6);
        }
      }
    }
    if (qosHandler)
      await qos.deallocateQoSHandlerForPolicy(pid);
  }

  async match(alarm) {
    log.info("Checking policies against", alarm.type, alarm.device, alarm['p.device.id']);
    const policies = await this.loadActivePoliciesAsync()

    const matchedPolicies = policies
      .filter(policy =>
        // excludes pbr and qos, lagacy blocking rule might not have action
        (!policy.action || ["allow", "block", "app_block"].includes(policy.action)) &&
        // low priority rule should not mute alarms
        !policy.isInboundAllowRule() &&
        !policy.isInboundFirewallRule() &&
        policy.match(alarm)
      )
      .sort((a,b) => a.priorityCompare(b))

    if (matchedPolicies.length) {
      const p = matchedPolicies[0]
      // still match allow policy with ip/domain, in other words
      // allow policy on a very specific target is considered as an exception for alarm
      if (p.action == 'allow' && !(p.type in ['ip', 'remoteIpPort', 'domain', 'dns'])) {
        log.info('ignore matched allow policy:', p.pid, p.action, p.type, p.target)
        return false
      } else {
        log.info('matched policy:', p.pid, p.action, p.type, p.target)
        return true
      }
    } else {
      return false
    }
  }


  // utility functions
  async findPolicy(target, type) {
    let rules = await this.loadActivePoliciesAsync();

    for (const index in rules) {
      const rule = rules[index]
      if (rule.target === target && type === rule.type) {
        return rule
      }
    }

    return null
  }

  isPort(port) {
    return (!Number.isNaN(port) && Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535)
  }

  async checkSearchTarget(target) {
    let result = {};
    let waitSearch = [];
    if (!target) {
      result.err = { code: 400, msg: "invalid target" };
      return result;
    }

    const addrPort = target.split(":");
    let isDomain = false;
    const addr = addrPort[0];
    if (!iptool.isV4Format(addr) && !this.isPort(addr)) {
      try {
        isDomain = validator.isFQDN(addr);
      } catch (err) {
      }
      if (!isDomain) {
        result.err = { code: 400, msg: "Invalid value" };
        return result;
      }
    }
    if (addrPort.length == 2 && (!this.isPort(addrPort[1]) || (this.isPort(addr) && this.isPort(addrPort[1])))) {
      result.err = { code: 400, msg: "Invalid value" };
      return result;
    }
    if (isDomain) {
      await domainBlock.resolveDomain(addr);
      const addresses = await dnsTool.getIPsByDomain(addr);
      waitSearch.push.apply(waitSearch, addresses);
      if (addrPort.length == 2) {
        waitSearch.push(addrPort[1]);
        for (const address of addresses) {
          waitSearch.push(address + "," + addrPort[1]); // for ipset test command
        }
      }
    } else {
      waitSearch.push(addr);
      if (addrPort.length == 2) {
        waitSearch.push(addrPort[1]);
        waitSearch.push(addr + "," + addrPort[1]); // for ipset test command
      }
    }

    result.err = null;
    result.waitSearch = waitSearch;
    result.isDomain = waitSearch;
    return result;
  }

  async searchPolicy(waitSearch, isDomain, target) {
    const addrPort = target.split(":");
    const targetDomain = addrPort[0];
    let ipsets = [];
    let ipsetContent = ""; // for string matching
    try {
      let cmdResult = await exec("sudo iptables -w -S | grep -E 'FW_FIREWALL'");
      let iptableFW = cmdResult.stdout.toString().trim(); // iptables content
      cmdResult = await exec(`sudo ipset -S`);
      let cmdResultContent = cmdResult.stdout.toString().trim().split('\n');
      for (const line of cmdResultContent) {
        const splitCurrent = line.split(" ");
        if (splitCurrent[0] == "create") {
          // ipset name
          if (iptableFW.indexOf(' ' + splitCurrent[1] + ' ') > -1) {
            // ipset name in iptables
            ipsets.push({ ipsetName: splitCurrent[1], ipsetType: splitCurrent[2] });
          }
        } else {
          //ipset content
          if (ipsets.some((current) => current.ipsetName == splitCurrent[1])) {
            ipsetContent += line + "\n";
          }
        }
      }
    } catch (err) {
      log.error(err);
    }

    let polices = [];
    let crossIps = [];
    const rules = await this.loadActivePoliciesAsync();
    for (const currentTxt of waitSearch) {
      if (!currentTxt || currentTxt.trim().length == 0) continue;
      log.info("Start check target:", currentTxt);
      for (const ipset of ipsets) {
        const ipsetName = ipset.ipsetName;
        if ((ipset.ipsetType == "hash:net" && iptool.isV4Format(currentTxt)) || (["hash:ip,port", "hash:net,port"].includes(ipset.ipsetType) && currentTxt.indexOf(",") > -1)) {
          // use ipset test command
          const testCommand = util.format("sudo ipset test %s %s", ipsetName, currentTxt);
          try {
            await exec(testCommand);
          } catch (err) {
            continue;
          }
        } else {
          // use string matching
          const testStr = "add " + ipsetName + " " + currentTxt + "\n";
          if (ipsetContent.indexOf(testStr) == -1) {
            continue;
          }
        }

        const matches = ipsetName.match(/(.*)_(\d+)_(.*)/); // match rule id
        let matchedRules = [];
        if (matches) {
          let rule = await this.getPolicy(matches[2]);
          if (rule) {
            matchedRules.push(rule);
          }
        } else if (['block_ip_set', 'sec_block_ip_set'].includes(ipsetName) && iptool.isV4Format(currentTxt)) {
          matchedRules = rules.filter(rule => rule.type == "ip" && rule.target === currentTxt);
        } else if (['block_net_set', 'sec_block_net_set'].includes(ipsetName) && iptool.isV4Format(currentTxt)) {
          matchedRules = rules.filter(rule => rule.type == "net" && iptool.cidrSubnet(rule.target).contains(currentTxt));
        } else if (['block_domain_set', 'sec_block_domain_set'].includes(ipsetName) && iptool.isV4Format(currentTxt)) {
          const filterRules = rules.filter(rule => ["dns", "domain"].includes(rule.type));
          if (isDomain) {
            const domains = await dnsTool.getAllDns(currentTxt); // 54.169.195.247 => ["api.github.com", "github.com"]
            if (domains && domains.length > 0) {
              for (const rule of filterRules) {
                if (domains.some(domain => (domain == rule.target || domain.indexOf(rule.target) > -1))) {
                  matchedRules.push(rule);
                }
              }
            }
          } else {
            for (const rule of filterRules) {
              const dnsAddresses = await dnsTool.getIPsByDomain(rule.target);
              if (dnsAddresses && dnsAddresses.length > 0 && dnsAddresses.some(dnsIp => dnsIp == currentTxt)) {
                matchedRules.push(rule);
              }
            }
          }
        } else if (ipsetName == "blocked_remote_port_set" && Number.isInteger(Number(currentTxt))) {
          const filterRules = rules.filter(rule => rule.type == "remotePort");
          for (const rule of filterRules) {
            let matchFlag = false;
            let splitTarget = rule.target.split("-");  //Example 9901-9908
            if (splitTarget.length == 2) {
              let portStart = splitTarget[0];
              let portEnd = splitTarget[1];
              if (Number.isInteger(Number(portStart)) && Number.isInteger(Number(portEnd)) && Number(currentTxt) >= Number(portStart) && Number(currentTxt) <= Number(portEnd)) {
                matchFlag = true;
              }
            } else if (rule.target == currentTxt) {
              matchFlag = true;
            }
            if (matchFlag) {
              matchedRules.push(rule);
            }
          }
        } else if (ipsetName == "blocked_remote_ip_port_set" && currentTxt.indexOf(",") > -1) {
          const filterRules = rules.filter(rule => rule.type == "remoteIpPort");
          for (const rule of filterRules) {
            let matchFlag = false;
            let splitTarget = rule.target.split(":"); //Example 101.89.76.251,tcp:44449
            let targetIp = splitTarget[0];
            let targetPort = splitTarget[1];
            if (targetIp.indexOf(",") > -1) {
              targetIp = targetIp.split(",")[0];
            }
            if (targetIp + "," + targetPort == currentTxt) {
              matchFlag = true;
            }
            if (matchFlag) {
              matchedRules.push(rule);
            }
          }
        } else if (ipsetName == "blocked_remote_net_port_set" && currentTxt.indexOf(",") > -1) {
          const filterRules = rules.filter(rule => rule.type == "remoteNetPort");
          let splitTxt = currentTxt.split(",");  //Example 10.0.0.1,44449
          let currentIp = splitTxt[0];
          let currentPort = splitTxt[1];
          for (const rule of filterRules) {
            let matchFlag = false;
            let splitTarget = rule.target.split(":"); //Example 10.0.0.0/8,tcp:44449
            let targetNet = splitTarget[0];
            let targetPort = splitTarget[1];
            if (targetNet.indexOf(",") > -1) {
              targetNet = targetNet.split(",")[0];
            }
            if (iptool.isV4Format(currentIp) && iptool.cidrSubnet(targetNet).contains(currentIp) && targetPort == currentPort) {
              matchFlag = true;
            }
            if (matchFlag) {
              matchedRules.push(rule);
            }
          }
        } else if (ipsetName.search(/c_bd_([a-zA-Z_]+)_set/) > -1 && iptool.isV4Format(currentTxt)) {
          matchedRules = rules.filter(rule => rule.type == "category" && ipsetName === Block.getDstSet(rule.target));
          if (isDomain) {
            for (const matchedRule of matchedRules) {
              let domains = await domainBlock.getCategoryDomains(matchedRule.target);
              domains = domains.filter(domain => !(domain == targetDomain || domain.indexOf(targetDomain) > -1));
              for (const domain of domains) {
                const dnsAddresses = await dnsTool.getIPsByDomain(domain);
                if (dnsAddresses && dnsAddresses.length > 0 && dnsAddresses.some(dnsIp => dnsIp == currentTxt)) {
                  crossIps.push({ ip: currentTxt, domain: domain, pid: matchedRule.pid });
                }
              }
            }
          }
        } else if (ipsetName.indexOf("_country:") > -1 && iptool.isV4Format(currentTxt)) {
          matchedRules = rules.filter(rule => rule.type == "country" && ipsetName === Block.getDstSet(countryUpdater.getCategory(rule.target)));
        }

        if (matchedRules.length > 0) {
          polices.push.apply(polices, matchedRules.map((rule) => rule.pid));
        }
      }
    }

    let result = {};
    result.polices = _.uniqWith(polices, _.isEqual);
    result.crossIps = _.uniqWith(crossIps, _.isEqual);
    return result;
  }

  async checkRunPolicies(initialFlag) {
    const disableAllFlag = await rclient.hgetAsync(policyDisableAllKey, "flag");
    if (this.disableAllTimer) {
      clearTimeout(this.disableAllTimer);
    }

    if (disableAllFlag == "on") {
      // just firemain started, not need unenforce all
      if (!initialFlag) {
        this.unenforceAllPolicies();
      }
      const startTime = await rclient.hgetAsync(policyDisableAllKey, "startTime");
      let expireMinute = await rclient.hgetAsync(policyDisableAllKey, "expire");
      if (expireMinute) {
        expireMinute = parseFloat(expireMinute);
      } else {
        expireMinute = 0;
      }

      if (startTime && expireMinute > 0) {
        const expiredTime = parseFloat(startTime) + expireMinute * 60;
        const timeoutSecond = expiredTime - new Date() / 1000;
        if (timeoutSecond > 60) {
          this.disableAllTimer = setTimeout(async () => { // set timeout(when disableAll flag expires, it will enforce all policy)
            await this.enforceAllPolicies();
            await rclient.hsetAsync(policyDisableAllKey, "flag", "off"); // set flag = off
          }, timeoutSecond * 1000);
        } else {
          // disableAll flag expired or expire soon
          await this.enforceAllPolicies();
          await rclient.hsetAsync(policyDisableAllKey, "flag", "off"); // set flag = off
        }
      }
    } else {
      await this.enforceAllPolicies();
    }
  }

  // deprecated
  async setDisableAll(flag, expireMinute) {
    const disableAllFlag = await rclient.hgetAsync(policyDisableAllKey, "flag");
    const expire = await rclient.hgetAsync(policyDisableAllKey, "expire");
    await rclient.hmsetAsync(policyDisableAllKey, {
      flag: flag,
      expire: expireMinute || 0,
      startTime: Date.now() / 1000
    });
    if (disableAllFlag !== flag || expire !== expireMinute || (flag == "on" && expireMinute)) {
      sem.emitEvent({
        type: 'PolicySetDisableAll',
        toProcess: 'FireMain',
        message: 'Policy SetDisableAll: ' + flag
      })
    }
  }

  async unenforceAllPolicies() {
    const rules = await this.loadActivePoliciesAsync();

    const unEnforcement = rules.filter(rule => rule.direction !== "inbound").map((rule) => {
      return new Promise((resolve, reject) => {
        try {
          if (this.queue) {
            const job = this.queue.createJob({
              policy: rule,
              action: "unenforce",
              booting: true
            })
            job.timeout(60000).save();
            job.on('succeeded', resolve);
            job.on('failed', resolve);
          }
        } catch (err) {
          log.error(`Failed to queue policy ${rule.pid}`, err)
          resolve(err)
        }
      })
    })

    await Promise.all(unEnforcement);
    log.info("All policy rules are unenforced");
  }

  async isDisableAll() {
    const disableAllFlag = await rclient.hgetAsync(policyDisableAllKey, "flag");
    if (disableAllFlag == "on") {
      const startTime = await rclient.hgetAsync(policyDisableAllKey, "startTime");
      let expireMinute = await rclient.hgetAsync(policyDisableAllKey, "expire");
      if (expireMinute) {
        expireMinute = parseFloat(expireMinute);
      } else {
        expireMinute = 0;
      }

      if (startTime && expireMinute > 0 && parseFloat(startTime) + expireMinute * 60 < new Date() / 1000) { // expired
        return false;
      }
      return true;
    } else if (disableAllFlag == "off") {
      return false
    }

    return false;
  }

  _getRuleSubPriority(type) {
    switch (type) {
      case "ip": // a specific remote ip
      case "remotePort":
      case "device": // a specific device
      case "devicePort":
        return 1;
      case "net":
      case "dns":
      case "domain":
      case "domain_re":
      case "tag": // a specific device group
        return 2;
      case "network": // a specific local network
      case "category":
        return 3;
      case "country":
        return 4;
      case "mac":
      case "internet":
      case "intranet": // all local networks
        return 5;
      default:
        return 3;
    }
  }

  async getDeviceByIdentity(identity) {
    let device = null;

    //check if there is a device policy that matches the criteria
    if (ht.isMacAddress(identity)) {
      if (!hostManager) {
        const HostManager = require('../net2/HostManager.js');
        hostManager = new HostManager()
      }
      device = await hostManager.getHostAsync(identity);
    } else if (IdentityManager.isGUID(identity)) {
      device = IdentityManager.getIdentityByGUID(identity);
    }

    return device;
  }

  async _matchLocal(rule, localMac) {
    if (!localMac)
      return false;
    if (rule.scope && rule.scope.length > 0) {
      if (!rule.scope.includes(localMac))
        return false;
    }
    // matching local device group if applicable
    if (rule.tags && rule.tags.length > 0) {
      // const tagId = rule.tags[0].substring(Policy.TAG_PREFIX.length);
      const tagId = rule.tags[0];
      // check if the localMac has this tag
      const device = await this.getDeviceByIdentity(localMac);
      if (!device)
        return false;
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const uids = await device.getTags(type) || [];
        if (uids.includes(tagId)) {
          return true;
        }
      }
      return false;
    }
    // matching local network if applicable
    if (rule.intfs && rule.intfs.length > 0) {
      if (ht.isMacAddress(localMac)) {
        const deviceIps = await ht.getIPsByMac(localMac);
        const deviceIP4 = deviceIps.filter(i => new Address4(i).isValid());
        const deviceIP6 = deviceIps.filter(i => new Address6(i).isValid());
        if (!rule.intfs.some(uuid => {
          const iface = sysManager.getInterfaceViaUUID(uuid);
          if (!iface || !iface.active)
            return false;
          if (deviceIP4.some(i => sysManager.inMySubnets4(i, iface.name)))
            return true;
          if (deviceIP6.some(i => sysManager.inMySubnet6(i, iface.name)))
            return true;
          return false;
        }))
          return false;
      } else {
        if (IdentityManager.isGUID(localMac)) {
          const { ns, uid } = IdentityManager.getNSAndUID(localMac);
          if (!rule.intfs.some(uuid => {
            const iface = sysManager.getInterfaceViaUUID(uuid);
            if (!iface || !iface.active)
              return false;
            const allIdentities = IdentityManager.getIdentitiesByNicName(iface.name);
            if (allIdentities[ns] && allIdentities[ns][uid])
              return true;
            else
              return false;
          }))
            return false;
        } else
          return false;
      }
    }
    // matching vpn profile if applicable
    if (rule.guids && rule.guids.length > 0) {
      if (!rule.guids.some(guid => guid === localMac))
        return false;
    }
    return true;
  }

  async _matchRemote(rule, remoteType, remoteVal, remoteIpsToCheck, protocol, remotePort) {
    const security = rule.isSecurityBlockPolicy();

    // matching remote target
    switch (rule.type) {
      case "ip": {
        if (!remoteIpsToCheck.includes(rule.target))
          return false;
        break;
      }
      case "net": {
        const net4 = new Address4(rule.target);
        const net6 = new Address6(rule.target);
        if (net4.isValid()) {
          if (!remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(net4)))
            return false;
        } else {
          if (net6.isValid()) {
            if (!remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(net6)))
              return false;
          }
        }
        break;
      }
      case "domain":
      case "dns": {
        if (remoteVal && (
          remoteVal.toLowerCase() === rule.target.toLowerCase()
          || remoteVal.toLowerCase().endsWith(`.${rule.target.toLowerCase()}`)
          || (rule.target.startsWith("*.") && remoteVal.toLowerCase().endsWith(rule.target.substring(1).toLowerCase()))
        ))
          return true;
        // matching ipset elements
        if (!rule.dnsmasq_only) {
          let remoteSet4 = null;
          let remoteSet6 = null;
          if (!_.isEmpty(rule.tags) || !_.isEmpty(rule.intfs) || !_.isEmpty(rule.scope) || !_.isEmpty(rule.guids) || rule.localPort || rule.remotePort || rule.parentRgId || Number.isInteger(rule.ipttl) || rule.seq !== Constants.RULE_SEQ_REG && !security) { // security block on all devices will use common ipset and iptables rule
            remoteSet4 = Block.getDstSet(rule.pid);
            remoteSet6 = Block.getDstSet6(rule.pid);
            if (!(this.ipsetCache[remoteSet4] && _.intersection(this.ipsetCache[remoteSet4], remoteIpsToCheck).length > 0) && !(this.ipsetCache[remoteSet6] && _.intersection(this.ipsetCache[remoteSet6], remoteIpsToCheck).length > 0))
              return false;
          } else {
            remoteSet4 = (security ? 'sec_' : '') + (rule.action === "allow" ? 'allow_' : 'block_') + (rule.direction === "inbound" ? "ib_" : (rule.direction === "outbound" ? "ob_" : "")) + simpleRuleSetMap[rule.type];
            remoteSet6 = remoteSet4 + "6";
            const mappedAddresses = (await domainIPTool.getMappedIPAddresses(rule.target, { blockSet: remoteSet4 })) || [];
            if (!(_.intersection(mappedAddresses, remoteIpsToCheck).length > 0)
              || !(this.ipsetCache[remoteSet4] && _.intersection(this.ipsetCache[remoteSet4], remoteIpsToCheck).length > 0) && !(this.ipsetCache[remoteSet6] && _.intersection(this.ipsetCache[remoteSet6], remoteIpsToCheck).length > 0)
            )
              return false;
          }
        } else return false;
        break;
      }
      case "domain_re": {
        try {
          const regex = new RegExp(rule.target);
          if (regex.test(remoteVal)) {
            return true;
          }
        } catch (err) {
          // pass
        }
        return false;
      }
      case "category": {
        const targets = _.isEmpty(rule.targets) ? [rule.target] : rule.targets;
        for (const target of targets) {
          const domains = await domainBlock.getCategoryDomains(target);
          if (remoteVal && domains.filter(domain => remoteVal === domain || (domain.startsWith("*.") && (remoteVal.endsWith(domain.substring(1)) || remoteVal === domain.substring(2)))).length > 0)
            return true;
          const remoteIPSet4 = categoryUpdater.getIPSetName(target, true);
          const remoteIPSet6 = categoryUpdater.getIPSetNameForIPV6(target, true);
          if ((this.ipsetCache[remoteIPSet4] && this.ipsetCache[remoteIPSet4].some(net => remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(new Address4(net))))) ||
            (this.ipsetCache[remoteIPSet6] && this.ipsetCache[remoteIPSet6].some(net => remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(new Address6(net))))))
            return true;
          if (!rule.dnsmasq_only) {
            const remoteDomainSet4 = categoryUpdater.getIPSetName(target, false);
            const remoteDomainSet6 = categoryUpdater.getIPSetNameForIPV6(target, false);
            if ((this.ipsetCache[remoteDomainSet4] && this.ipsetCache[remoteDomainSet4].some(net => remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(new Address4(net))))) ||
              (this.ipsetCache[remoteDomainSet6] && this.ipsetCache[remoteDomainSet6].some(net => remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(new Address6(net))))))
              return true;
          }
  
          if (remotePort && protocol) {
            const domainsWithPort = await domainBlock.getCategoryDomainsWithPort(target);
            for (const domainObj of domainsWithPort) {
              if (domainObj.id === remoteVal && domainObj.port.start <= remotePort && remotePort <= domainObj.port.end && domainObj.port.proto === protocol) {
                return true;
              }
            }
            const netportIpset4 = categoryUpdater.getNetPortIPSetName(target);
            const domainportIpset4 = categoryUpdater.getDomainPortIPSetName(target);
            let elements = [];
            if (this.ipsetCache[netportIpset4])
              elements = elements.concat(this.ipsetCache[netportIpset4]);
            if (this.ipsetCache[domainportIpset4])
              elements = elements.concat(this.ipsetCache[domainportIpset4]);
            for (const item of elements) {
              let [net, protoport] = item.split(",");
              if (protoport !== `${protocol}:${remotePort}`) {
                continue;
              }
              for (const ip of remoteIpsToCheck) {
                const ipv4 = new Address4(ip);
                if (ipv4.isValid() && ipv4.isInSubnet(new Address4(net))) {
                  return true;
                }
              }
            }
            
            const netportIpset6 = categoryUpdater.getNetPortIPSetNameForIPV6(target);
            const domainportIpset6 = categoryUpdater.getDomainPortIPSetNameForIPV6(target);
            elements = [];
            if (this.ipsetCache[netportIpset6])
              elements = elements.concat(this.ipsetCache[netportIpset6]);
            if (this.ipsetCache[domainportIpset6])
              elements = elements.concat(this.ipsetCache[domainportIpset6]);
            for (const item of elements) {
              let [net, protoport] = item.split(",");
              if (protoport !== `${protocol}:${remotePort}`) {
                continue;
              }
              for (const ip of remoteIpsToCheck) {
                const ipv6 = new Address6(ip);
                if (ipv6.isValid() && ipv6.isInSubnet(new Address6(net))) {
                  return true;
                }
              }
            }
          }
        }
        return false;
        break;
      }
      case "country": {
        const targets = _.isEmpty(rule.targets) ? [rule.target] : rule.targets;
        for (const target of targets) {
          const remoteSet4 = categoryUpdater.getIPSetName(countryUpdater.getCategory(target));
          const remoteSet6 = categoryUpdater.getIPSetNameForIPV6(countryUpdater.getCategory(target));
          if ((this.ipsetCache[remoteSet4] && this.ipsetCache[remoteSet4].some(net => remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(new Address4(net))))) ||
            (this.ipsetCache[remoteSet6] && this.ipsetCache[remoteSet6].some(net => remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(new Address6(net)))))
          )
            return true;
        }
        return false;
        break;
      }
      case "intranet":
        if (!remoteIpsToCheck.some(ip => sysManager.inMySubnets4(ip) || sysManager.inMySubnet6(ip)))
          return false;
        break;
      case "mac":
      case "internet":
        if (remoteIpsToCheck.filter(ip => sysManager.inMySubnets4(ip) || sysManager.inMySubnet6(ip)).length === remoteIpsToCheck.length)
          return false;
        break;
      case "network":
        const iface = rule.target && sysManager.getInterfaceViaUUID(rule.target);
        if (!iface || !remoteIpsToCheck.some(ip => sysManager.inMySubnets4(ip, iface.name) || sysManager.inMySubnet6(ip, iface.name)))
          return false;
        break;
      case "tag":
      case "device":
        // not supported yet
        return false;
      default:
    }
    return true;
  }

  filterAndSortRule(rules) {
    let sortedRules = rules.map(rule => {
      let { scope, target, action = "block", tag, guids } = rule;
      rule.type = rule["i.type"] || rule["type"];
      rule.direction = rule.direction || "bidirection";
      const intfs = [];
      let tags = [];
      if (!_.isEmpty(tag)) {
        let invalid = true;
        for (const tagStr of tag) {
          if (tagStr.startsWith(Policy.INTF_PREFIX)) {
            invalid = false;
            let intfUuid = tagStr.substring(Policy.INTF_PREFIX.length);
            intfs.push(intfUuid);
          } else {
            for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
              const config = Constants.TAG_TYPE_MAP[type];
              if (tagStr.startsWith(config.ruleTagPrefix)) {
                invalid = false;
                const tagUid = tagStr.substring(config.ruleTagPrefix.length);
                tags.push(tagUid);
              }
            }
            tags = _.uniq(tags);
          }
        }
        if (invalid) {
          rule.rank = -1;
          return rule;
        }
      }

      const seq = rule.getSeq()

      rule.rank = 6;
      if (scope && scope.length > 0)
        rule.rank = 0;
      if (tags && tags.length > 0)
        rule.rank = 2;
      if (guids && guids.length > 0)
        rule.rank = 0;
      if (intfs && intfs.length > 0)
        rule.rank = 4;
      if (rule.parentRgId)
        rule.rank = 8;
      switch (rule.type) {
        case "ip":
        case "net":
          break;
        case "remotePort":
          rule.remotePort = target;
          break;
        case "mac":
        case "internet":
          if (ht.isMacAddress(target)) {
            rule.scope = [target];
            rule.rank = 0;
          }
          break;
        case "domain":
        case "dns":
        case "domain_re":
          break;
        case "devicePort":
          let data = this.parseDevicePortRule(target);
          if (data && data.mac) {
            rule.protocol = data.protocol;
            rule.localPort = data.port;
            rule.scope = [data.mac];
            rule.rank = 0;
            rule.direction = "inbound";
          } else {
            rule.rank = -1;
          }
          break;
        case "category":
        case "country":
        case "intranet":
        case "network":
        case "tag":
        case "device":
          break;
        default:
      }
      rule.intfs = intfs;
      rule.tags = tags;

      if (action === "block" || action === "app_block")
        // block has lower priority than allow
        rule.rank++;
      if (action === "match_group" || rule.type === "match_group")
        // a trick that makes match_group rule be checked after allow rule and before block rule
        rule.rank += 0.5;
      // high priority rule has a smaller base rank
      if (rule.rank >= 0 && rule.action != "route") {
        switch (seq) {
          case Constants.RULE_SEQ_REG:
            // security block still has high priority and low rank
            if (!rule.isSecurityBlockPolicy())
              rule.rank += 10;
            break;
          case Constants.RULE_SEQ_LO:
            rule.rank += 20;
            break;
          default:
        }
      }
      return rule;
      // sort rules by rank in ascending order
    }).filter(rule => rule.rank >= 0).sort((a, b) => { return a.rank - b.rank });
    return sortedRules;
  }

  async getBestMatchRule(rules, localMac, localPort, remoteType, remoteVal = "", remotePort, protocol, direction = "outbound") {
    let remoteIpsToCheck = [];
    switch (remoteType) {
      case "ip":
        if (remoteVal)
          remoteIpsToCheck.push(remoteVal);
        break;
      case "domain":
        if (remoteVal)
          remoteIpsToCheck = (await dnsTool.getIPsByDomain(remoteVal)) || [];
        if (remoteIpsToCheck.length === 0) // domain exact match not found, try matching domain pattern
          remoteIpsToCheck.push.apply(remoteIpsToCheck, (await dnsTool.getIPsByDomainPattern(remoteVal)));
        break;
      default:
    }

    for (const rule of rules) {
      // rules in rule group will be checked in match_group rule
      if (rule.parentRgId)
        continue;
      if (rule.action === "app_block") {
        if (_.isObject(rule.appTimeUsage) && rule.appTimeUsed) {
          if (rule.appTimeUsage.quota > rule.appTimeUsed)
            continue;
        }
      }
      // matching local port if applicable
      if (rule.localPort) {
        if (!localPort)
          continue;
        const ranges = rule.localPort.split("-", 2).map(n => Number(n));
        if (ranges.length === 1)
          if (Number(localPort) !== ranges[0])
            continue;
        if (ranges.length > 1)
          if (Number(localPort) < ranges[0] || Number(localPort) > ranges[1])
            continue;
      }
      // matching remote port if applicable
      if (rule.remotePort) {
        if (!remotePort)
          continue;
        const ports = rule.remotePort.split(",");
        let matched = false;
        for (const port of ports) {
          const ranges = port.split("-", 2).map(n => Number(n));
          if (ranges.length === 1)
            if (Number(remotePort) === ranges[0]) {
              matched = true;
              break;
            }
          if (ranges.length > 1)
            if (Number(remotePort) >= ranges[0] || Number(remotePort) <= ranges[1]) {
              matched = true;
              break;;
            }
        }
        if (!matched)
          continue;
      }
      // matching direction if applicable
      if (rule.direction !== direction && rule.direction !== "bidirection" && direction !== "bidirection") {
        continue;
      }
      // matching protocol if applicable
      if (rule.protocol) {
        if (!protocol || rule.protocol !== protocol)
          continue;
      }
      if (!await this._matchLocal(rule, localMac)) {
        continue;
      }

      if (rule.action === "match_group" || rule.type === "match_group") {
        // check rules in the rule group against remote target
        const targetRgId = rule.targetRgId;
        if (!targetRgId)
          continue;
        const subRules = rules.filter(r => r.parentRgId === targetRgId); // allow rules come first in the subRules list, the rank should be 8 and 9
        for (const subRule of subRules) {
          if (await this._matchRemote(subRule, remoteType, remoteVal, remoteIpsToCheck, protocol, remotePort)) {
            return subRule;
          }
        }
        continue;
      } else {
        if (!await this._matchRemote(rule, remoteType, remoteVal, remoteIpsToCheck, protocol, remotePort))
          continue;
      }
      // reach here if the rule matches the criteria
      return rule;
    }
    return null;
  }

  async loadAllVpnClientsState() {
    const allVpnClientsStr = await rclient.hgetAsync("policy:system", "vpnClient");
    if (!allVpnClientsStr)
      return null;

    const allVpnClients = JSON.parse(allVpnClientsStr);
    if (!allVpnClients || !allVpnClients.multiClients) {
      return null;
    }
    return allVpnClients;
  }

  isVpnClientEnabled(allVpnClients, vpnClientId) {
    if (!allVpnClients || !allVpnClients.multiClients)
      return false;
    for (const vpnClient of allVpnClients.multiClients) {
      const vpnType = vpnClient.type;
      const vpnProfileInfo = vpnClient[vpnType];
      if (vpnProfileInfo && vpnProfileInfo.profileId && vpnProfileInfo.profileId == vpnClientId) {
        return vpnClient.state;
      }
    }
    return false;
  }

  async checkVPN(allVpnClients, resultMap, vpnClientId, routeType = "hard") {
    let isEnabled = false;
    let isConnected = false;
    let isStrictVPN = false;

    if (resultMap.has(vpnClientId)) { // found in resultMap, retrun result directly
      isEnabled = resultMap[vpnClientId].isEnabled;
      isConnected = resultMap[vpnClientId].isConnected;
      isStrictVPN = resultMap[vpnClientId].isStrictVPN;
    } else {
      let vpnClient = VPNClient.getInstance(vpnClientId);
      if (!vpnClient) {
        return false;
      }
      isEnabled = this.isVpnClientEnabled(allVpnClients, vpnClientId);
      isConnected = await vpnClient.status();
      const settings = await vpnClient.loadSettings();
      if (settings && settings.strictVPN) {
        isStrictVPN = true;
      }
      resultMap[vpnClientId] = {isEnabled:isEnabled, isConnected:isConnected, isStrictVPN:isStrictVPN};
    }

    if (!isEnabled) {
      return false;
    }
    if (!isConnected) {
      if (!isStrictVPN) {
        return false;
      }
      if (routeType == "soft") {
        return false;
      }
    }

    return true;
  }

  // check the rule created by VPN client
  async getBestMatchVpnPolicie(localMac, allVpnClients) {
    let policies = [];

    //check if there is a device policy that matches the criteria
    const device = await this.getDeviceByIdentity(localMac);
    if (!device)
      return null;

    const devicePolicy = await device.loadPolicyAsync();
    if (devicePolicy) {
      devicePolicy.rank = 0;
      devicePolicy.matchedTarget = localMac;
      policies.push(devicePolicy);
    }

    // check if there is a group policy that matches the criteria
    let tags = [];
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const uids = await device.getTags(type) || [];
      tags.push(...uids);
    }
    tags = _.uniq(tags);

    for (const tagId of tags) {
      const tag = tagManager.getTagByUid(tagId);
      const groupPolicy = await tag.loadPolicyAsync();
      if (groupPolicy && Object.keys(groupPolicy).length !== 0){
        groupPolicy.rank = 2;
        groupPolicy.matchedTarget = "tag:" + tag.getTagUid();
        policies.push(groupPolicy);
      }
    }

    // check if there is a network policy that matches the criteria
    const nicUUID = device.getNicUUID();
    const networkProfile = NetworkProfileManager.getNetworkProfile(nicUUID);
    const networkPolicy = await networkProfile.loadPolicyAsync();
    if (networkPolicy && Object.keys(networkPolicy).length !== 0) {
      networkPolicy.rank = 4;
      networkPolicy.matchedTarget = "network:" + nicUUID;
      policies.push(networkPolicy);
    }

    const checkedVpnMap = new Map();
    for (const policy of policies) {
      const vpnClient = policy.vpnClient;
      if (!vpnClient || !vpnClient.profileId)
        continue;
      const matched = await this.checkVPN(allVpnClients, checkedVpnMap, vpnClient.profileId);

      if (matched) {
        policy.wanUUID = Block.VPN_CLIENT_WAN_PREFIX + vpnClient.profileId;
        return policy;
      }
    }

    return null;
  }

  async initIpsetCache() {
    if (!this.ipsetCache || (this.ipsetCacheUpdateTime && Date.now() / 1000 - this.ipsetCacheUpdateTime > 60)) { // ipset cache becomes invalid after 60 seconds
      this.ipsetCache = await ipset.readAllIpsets() || {};
      this.ipsetCacheUpdateTime = Date.now() / 1000
    }
  }

  /**
   * 
   * @returns
   * {
   *   "wanUUID": "xxxx-xxxx"/"VC:xxxxx", // either wan UUID or VPN client profile id pretending with "VC:"
   *   "reason": "rule"/"policy", // return "rule" if it is determined by a rule, or return "policy" if it is determined by VPN client settings
   *   "pid": "123", // rule id if reason is "rule"
   *   "target": "xxxxx" // MAC address if reason is "policy" and the VPN client is applied to a device, or "tag:<group_id>" 
   * }
   */
  async checkRoute(localMac, localPort, remoteType, remoteVal = "", remotePort, protocol, direction = "outbound") {

    await this.initIpsetCache();

    if (!this.sortedRoutesCache) {
      let routes = await this.loadActivePoliciesAsync() || [];
      routes = routes.filter(rule => rule.action === "route");
      this.sortedRoutesCache = this.filterAndSortRule(routes);
    }
    // 1. if a VPN client is mannually disabled, all route rule and policies using it should be ignored.
    // 2. if a VPN client is enabled but disconnected at the moment, and the kill switch(strictVPN) is not enabled on it, all route rules and policies using it should be ingnored
    // 3. if routeType in a route is soft and the wan/VPN client in the rule is disconnected, the rule should be ignored.

    let activeRules = [];
    let checkedVpnMap = new Map();
    const allVpnClients = await this.loadAllVpnClientsState();

    for (const rule of this.sortedRoutesCache) {
      if (rule.wanUUID.startsWith(Block.VPN_CLIENT_WAN_PREFIX)) {
        const vpnID = rule.wanUUID.substring(Block.VPN_CLIENT_WAN_PREFIX.length);
        const vpnCheckRsult = await this.checkVPN(allVpnClients, checkedVpnMap, vpnID, rule.routeType);
        if (!vpnCheckRsult) {
          continue;
        }
      } else if (rule.routeType == "soft") {
        // check if the wan interface is up
        const wanUUID = rule.wanUUID;
        const networkProfile = NetworkProfileManager.getNetworkProfile(wanUUID);
        if (!networkProfile.isReady()) {
          continue;
        }
      }
      activeRules.push(rule);
    }
    let result = null;
    const bestMatchRoute = await this.getBestMatchRule(activeRules, localMac, localPort, remoteType, remoteVal, remotePort, protocol, direction);
    if (bestMatchRoute) {
      const matchedTarget = Policy.getMathcedTarget(bestMatchRoute);
      result = {
        "wanUUID": bestMatchRoute.wanUUID,
        "reason": "rule",
        "pid": bestMatchRoute.pid,
        "target": matchedTarget
      }
    }


    const bestMatchVpnPolicy = await this.getBestMatchVpnPolicie(localMac, allVpnClients);
    if (bestMatchVpnPolicy) {
      if (!result || bestMatchVpnPolicy.rank < bestMatchRoute.rank) {
        result = {
          "wanUUId": bestMatchVpnPolicy.wanUUID,
          "reason": "policy",
          "target": bestMatchVpnPolicy.matchedTarget
        }
      }
    }
    return result;
  }

  async checkACL(localMac, localPort, remoteType, remoteVal = "", remotePort, protocol, direction = "outbound") {
    await this.initIpsetCache();

    if (!this.sortedActiveRulesCache) {
      let activeRules = await this.loadActivePoliciesAsync() || [];
      activeRules = activeRules.filter(rule => !rule.action || ["allow", "block", "match_group", "app_block"].includes(rule.action) || rule.type === "match_group").filter(rule => (!rule.cronTime || scheduler.shouldPolicyBeRunning(rule)));
      this.sortedActiveRulesCache = this.filterAndSortRule(activeRules);
    }

    return await this.getBestMatchRule(this.sortedActiveRulesCache, localMac, localPort, remoteType, remoteVal, remotePort, protocol, direction);
  }

  async batchPolicy(actions) {
    let results = {
      'create': [],
      'update': [],
      'delete': []
    };
    for (const action in actions) {
      const rawData = actions[action] || [];
      switch (action) {
        case 'create':
          for (const rawPolicy of rawData) {
            const { policy, alreadyExists } = await this.checkAndSaveAsync(new Policy(rawPolicy));
            let result = policy;
            if (alreadyExists == 'duplicated') {
              result = 'duplicated'
            }
            results.create.push(result);
          }
          break;
        case 'update':
          for (const rawPolicy of rawData) {
            const pid = rawPolicy.pid;
            const oldPolicy = await this.getPolicy(pid)
            const policyObj = new Policy(Object.assign({}, oldPolicy, rawPolicy));
            const samePolicies = await this.getSamePolicies(policyObj);
            if (_.isArray(samePolicies) && samePolicies.filter(p => p.pid != pid).length > 0) {
              results.update.push('duplicated');
            } else {
              await this.updatePolicyAsync(rawPolicy);
              const newPolicy = await this.getPolicy(pid);
              this.tryPolicyEnforcement(newPolicy, 'reenforce', oldPolicy);
              results.update.push(newPolicy);
            }
          }
          break;
        case 'delete':
          for (const policyID of rawData) {
            let policy = await this.getPolicy(policyID);
            let result;
            if (policy) {
              await this.disableAndDeletePolicy(policyID);
              policy.deleted = true;
              result = policy;
            } else {
              result = "invalid policy";
            }
            results.delete.push(result);
          }
          break;
      }
    }
    return results;
  }

  _getRuleGroupRedisKey(uuid) {
    return `rule_group:${uuid}`;
  }

  async createOrUpdateRuleGroup(uuid, obj) {
    if (!obj || !obj.name)
      throw new Error("name is not defined");

    if (!uuid) // generate random uuid
      uuid = require('uuid').v4();

    obj.uuid = uuid;
    const key = this._getRuleGroupRedisKey(uuid);
    await rclient.unlinkAsync(key);
    await rclient.hmsetAsync(key, obj);
    return obj;
  }

  async removeRuleGroup(uuid) {
    const key = this._getRuleGroupRedisKey(uuid);
    await rclient.unlinkAsync(key);
  }

  async getAllRuleGroupMetaData() {
    const keys = await rclient.keysAsync("rule_group:*");
    const objs = [];
    for (const key of keys) {
      const obj = await rclient.hgetallAsync(key);
      if (obj)
        objs.push(obj);
    }
    return objs;
  }

  checkValidDomainRE(expr) {
    try {
      new RegExp(expr)
    } catch (e) {
      return false;
    }
    // do not allow slash because it is a separator in dnsmasq config and it is not useful in domain match.
    if (expr.includes("/")) {
      return false;
    }
    // do not allow lookaround or non-capturing group
    if (expr.includes("(?")) {
      return false;
    }
    // do not allow back reference, it may induce exponential match time.
    const backRefExp = /\\[0-9]/;
    if (backRefExp.test(expr)) {
      return false
    }
    return true;
  }

  async deletePoliciesData(policyArray) {
    if (policyArray.length) {
      await rclient.unlinkAsync(policyArray.map(p => this.getPolicyKey(p.pid)))
      await rclient.zremAsync(policyActiveKey, policyArray.map(p => p.pid))
    }
  }

  scheduleRefreshConnmark() {
    if (this._refreshConnmarkTimeout)
      clearTimeout(this._refreshConnmarkTimeout);
    this._refreshConnmarkTimeout = setTimeout(async () => {
      // use conntrack to clear the first bit of connmark on existing connections
      await exec(`sudo conntrack -U -m 0x00000000/0x80000000`).catch((err) => {
        log.warn(`Failed to clear first bit of connmark on existing IPv4 connections`, err.message);
      });
      await exec(`sudo conntrack -U -f ipv6 -m 0x00000000/0x80000000`).catch((err) => {
        log.warn(`Failed to clear first bit of connmark on existing IPv6 connections`, err.message);
      });
    }, 5000);
  }
}

module.exports = PolicyManager2;
