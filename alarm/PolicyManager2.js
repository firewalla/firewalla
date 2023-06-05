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

const rclient = require('../util/redis_manager.js').getRedisClient()

const Bone = require('../lib/Bone.js');

const minimatch = require('minimatch')

const sysManager = require('../net2/SysManager.js')
const tm = require('./TrustManager.js');

let instance = null;

const policyActiveKey = "policy_active";
const policyIDKey = "policy:id";
const policyPrefix = "policy:";
const policyDisableAllKey = "policy:disable:all";
const initID = 1;
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
const screenTime = require('../extension/accounting/screentime.js')

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

const delay = require('../util/util.js').delay;
const validator = require('validator');
const iptool = require('ip');
const util = require('util');
const exec = require('child-process-promise').exec;
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

const IdentityManager = require('../net2/IdentityManager.js');

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
        return this._enforce(policy)
      }

      scheduler.unenforceCallback = (policy) => {
        return this._unenforce(policy)
      }

      this.enabledTimers = {}
      this.disableAllTimer = null;

      this.ipsetCache = null;
      this.ipsetCacheUpdateTime = null;
      this.sortedActiveRulesCache = null;
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
            log.info("START ENFORCING POLICY", policy.pid, action);
            await this.enforce(policy)
          } catch (err) {
            log.error("enforce policy failed:" + err, policy)
          } finally {
            log.info("COMPLETE ENFORCING POLICY", policy.pid, action);
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

      sem.emitEvent({
        type: 'PolicyEnforcement',
        toProcess: 'FireMain',//make sure firemain process handle enforce policy event
        message: 'Policy Enforcement:' + action,
        action: action, //'enforce', 'unenforce', 'reenforce'
        policy: policy,
        oldPolicy: oldPolicy
      })
    }
  }

  createPolicyIDKey(callback) {
    rclient.set(policyIDKey, initID, callback);
  }

  getNextID(callback) {
    rclient.get(policyIDKey, (err, result) => {
      if (err) {
        log.error("Failed to get policyIDKey: " + err);
        callback(err);
        return;
      }

      if (result) {
        rclient.incr(policyIDKey, (err, newID) => {
          if (err) {
            log.error("Failed to incr policyIDKey: " + err);
          }
          callback(null, newID);
        });
      } else {
        this.createPolicyIDKey((err) => {
          if (err) {
            log.error("Failed to create policyIDKey: " + err);
            callback(err);
            return;
          }

          rclient.incr(policyIDKey, (err) => {
            if (err) {
              log.error("Failed to incr policyIDKey: " + err);
            }
            callback(null, initID);
          });
        });
      }
    });
  }

  addToActiveQueue(policy, callback) {
    //TODO
    let score = parseFloat(policy.timestamp);
    let id = policy.pid;
    rclient.zadd(policyActiveKey, score, id, (err) => {
      if (err) {
        log.error("Failed to add policy to active queue: " + err);
      }
      callback(err);
    });
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
  }

  savePolicyAsync(policy) {
    return new Promise((resolve, reject) => {
      this.savePolicy(policy, (err) => {
        if (err)
          reject(err);

        resolve();
      })
    })
  }

  savePolicy(policy, callback) {
    callback = callback || function () { }

    log.info("In save policy:", policy);

    this.getNextID((err, id) => {
      if (err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      policy.pid = id + ""; // convert to string

      let policyKey = policyPrefix + id;

      rclient.hmset(policyKey, policy.redisfy(), (err) => {
        if (err) {
          log.error("Failed to set policy: " + err);
          callback(err);
          return;
        }

        this.addToActiveQueue(policy, (err) => {
          if (!err) {
          }
          this.tryPolicyEnforcement(policy)
          callback(null, policy)
        });

        Bone.submitIntelFeedback('block', policy, 'policy');
      });
    });
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
        if (samePolicy.disabled && samePolicy.disabled == "1") {
          // there is a policy in place and disabled, just need to enable it
          await this.enablePolicy(samePolicy)
          callback(null, samePolicy, "duplicated_and_updated")
        } else {
          callback(null, samePolicy, "duplicated")
        }
      } else {
        this.savePolicy(policy, callback);
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

  policyExists(policyID) {
    return new Promise((resolve, reject) => {
      rclient.keys(policyPrefix + policyID, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(result !== null);
      });
    });
  }

  getPolicy(policyID) {
    return new Promise((resolve, reject) => {
      this.idsToPolicies([policyID], (err, results) => {
        if (err) {
          reject(err);
          return;
        }

        if (results == null || results.length === 0) {
          resolve(null)
          return
        }

        resolve(results[0]);
      });
    });
  }

  async getSamePolicies(policy) {
    let policies = await this.loadActivePoliciesAsync({ includingDisabled: true });

    if (policies) {
      return policies.filter((p) => policy.isEqualToPolicy(p))
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
    Bone.submitIntelFeedback('enable', policy, 'policy')
    return policy
  }

  async disablePolicy(policy) {
    if (policy.disabled == '1') {
      return // do nothing, since it's already disabled
    }
    await this._disablePolicy(policy)
    this.tryPolicyEnforcement(policy, "unenforce")
    Bone.submitIntelFeedback('disable', policy, 'policy')
  }

  async resetStats(policyID) {
    log.info("Trying to reset policy hit count: " + policyID);
    const exists = this.policyExists(policyID)
    if (!exists) {
      log.error("policy " + policyID + " doesn't exists");
      return
    }

    const policyKey = policyPrefix + policyID;
    const resetTime = new Date().getTime() / 1000;
    const multi = rclient.multi();
    multi.hdel(policyKey, "hitCount");
    multi.hdel(policyKey, "lastHitTs");
    multi.hset(policyKey, "statsResetTs", resetTime);
    await multi.execAsync()
  }

  async disableAndDeletePolicy(policyID) {
    if (!policyID) return;

    let policy = await this.getPolicy(policyID);

    if (!policy) {
      return;
    }

    await this.deletePolicy(policyID); // delete before broadcast

    this.tryPolicyEnforcement(policy, "unenforce")
    Bone.submitIntelFeedback('unblock', policy, 'policy');
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
      if (_.isEmpty(rule.tag)) continue;

      const tagUid = Policy.TAG_PREFIX + tag;
      if (rule.tag.some(m => m == tagUid)) {
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

    if (policyIds.length) {
      await rclient.unlinkAsync(policyKeys);
      await rclient.zremAsync(policyActiveKey, policyIds);
    }
    log.info('Deleted', tag, 'related policies:', policyKeys);
  }

  idsToPolicies(ids, callback) {
    let multi = rclient.multi();

    ids.forEach((pid) => {
      multi.hgetall(policyPrefix + pid);
    });

    multi.exec((err, results) => {
      if (err) {
        log.error("Failed to load policies (hgetall): " + err);
        callback(err);
        return;
      }

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
        return b.timestamp > a.timestamp
      })

      callback(null, rr)

    });
  }

  loadRecentPolicies(duration, callback) {
    if (typeof (duration) == 'function') {
      callback = duration;
      duration = 86400;
    }

    callback = callback || function () { }

    let scoreMax = new Date() / 1000 + 1;
    let scoreMin = scoreMax - duration;
    rclient.zrevrangebyscore(policyActiveKey, scoreMax, scoreMin, (err, policyIDs) => {
      if (err) {
        log.error("Failed to load active policies: " + err);
        callback(err);
        return;
      }

      this.idsToPolicies(policyIDs, callback);
    });
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

  loadActivePoliciesAsync(options) {
    return new Promise((resolve, reject) => {
      this.loadActivePolicies(options, (err, policies) => {
        if (err) {
          reject(err)
        } else {
          resolve(policies)
        }
      })
    })
  }

  // we may need to limit number of policy rules created by user
  loadActivePolicies(options, callback) {

    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    options = options || {};
    let number = options.number || policyCapacity;
    callback = callback || function () { };

    rclient.zrevrange(policyActiveKey, 0, number - 1, (err, results) => {
      if (err) {
        log.error("Failed to load active policies: " + err);
        callback(err);
        return;
      }

      this.idsToPolicies(results, (err, policyRules) => {
        if (options.includingDisabled) {
          callback(err, policyRules)
        } else {
          callback(err, err ? [] : policyRules.filter((r) => {
            return r.disabled != "1";
          })) // remove all disabled one or it was disabled cause idle
        }
      });
    });
  }

  // cleanup before use
  async cleanupPolicyData() {
    await domainIPTool.removeAllDomainIPMapping()
    await tm.reset();
  }

  async enforceAllPolicies() {
    const rules = await this.loadActivePoliciesAsync({includingDisabled : 1});

    const initialEnforcement = rules.map((rule) => {
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
    })

    await Promise.all(initialEnforcement);

    log.info(">>>>>==== All policy rules are enforced ====<<<<<")

    sem.emitEvent({
      type: 'Policy:AllInitialized',
      toProcess: 'FireMain', //make sure firemain process handle enforce policy event
      message: 'All policies are enforced'
    })
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
    return target && (sysManager.isMyServer(target) ||
      // sysManager.myIp() === target ||
      sysManager.isMyIP(target) ||
      sysManager.isMyMac(target) ||
      // compare mac, ignoring case
      sysManager.isMyMac(target.substring(0, 17)) || // devicePort policies have target like mac:protocol:prot
      ".firewalla.encipher.io".endsWith(`.${target}`) || 
      ".firewalla.com".endsWith(`.${target}`) ||
      minimatch(target, "*.firewalla.com"))
  }

  async enforce(policy) {
    if (await this.isDisableAll()) {
      return policy; // temporarily by DisableAll flag
    }

    if (policy.disabled == 1) {
      const idleInfo = policy.getIdleInfo();
      if (!idleInfo) return;
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
    } else if (policy.action == 'screentime') {
      // this is a screentime policy, use screenTime to manage it
      return screenTime.registerPolicy(policy);
    } else {
      return this._enforce(policy); // regular enforce
    }
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
        } else if (tagStr.startsWith(Policy.TAG_PREFIX)) {
          let tagUid = tagStr.substring(Policy.TAG_PREFIX.length);
          const tagExists = await tagManager.tagUidExists(tagUid)
          if (tagExists) tags.push(tagUid);
        }
      }
    }

    return { intfs, tags }
  }

  async _enforce(policy) {
    log.info(`Enforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, action:${policy.action || "block"}`);

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    await this._refreshActivatedTime(policy)

    if (this.isFirewallaOrCloud(policy) && (policy.action || "block") === "block") {
      throw new Error("Firewalla and it's cloud service can't be blocked.")
    }

    let { pid, scope, target, action = "block", tag, remotePort, localPort, protocol, direction, upnp, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, owanUUID, origDst, origDport, snatIP, routeType, guids, parentRgId, targetRgId, ipttl, seq, resolver, flowIsolation } = policy;

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
    const subPrio = this._getRuleSubPriority(type, target);

    if (!seq) {
      seq = Constants.RULE_SEQ_REG;
      if (security)
        seq = Constants.RULE_SEQ_HI;
      if (this._isActiveProtectRule(policy))
        seq = Constants.RULE_SEQ_HI;
      if (this._isInboundAllowRule(policy))
        seq = Constants.RULE_SEQ_LO;
      if (this._isInboundFirewallRule(policy))
        seq = Constants.RULE_SEQ_LO;
    }

    let remoteSet4 = null;
    let remoteSet6 = null;
    let localPortSet = null;
    let remotePortSet = null;
    let remotePositive = true;
    let remoteTupleCount = 1;
    let ctstate = null;
    let tlsHostSet = null;
    let tlsHost = null;
    let skipFinalApplyRules = false;
    let qosHandler = null;
    if (localPort) {
      localPortSet = `c_${pid}_local_port`;
      await ipset.create(localPortSet, "bitmap:port");
      await Block.batchBlock(localPort.split(","), localPortSet);
    }
    if (remotePort) {
      remotePortSet = `c_${pid}_remote_port`;
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
          await ipset.create(remoteSet4, ruleSetTypeMap[type], true);
          await ipset.create(remoteSet6, ruleSetTypeMap[type], false);
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
            await ipset.create(remoteSet4, "hash:ip", true);
            await ipset.create(remoteSet6, "hash:ip", false);
          }
          if (type === "remoteNetPort") {
            remoteSet4 = Block.getDstSet(pid);
            remoteSet6 = Block.getDstSet6(pid);
            await ipset.create(remoteSet4, "hash:net", true);
            await ipset.create(remoteSet6, "hash:net", false);
          }
          await Block.block(values[0], Block.getDstSet(pid));
          remotePort = values[1];
        }

        if (remotePort) {
          remotePortSet = `c_${pid}_remote_port`;
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
          if (direction !== "inbound" && !localPort && !remotePort) {
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
            await ipset.create(remoteSet4, "hash:ip", true, ipttl);
            await ipset.create(remoteSet6, "hash:ip", false, ipttl);
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
            localPortSet = `c_${pid}_local_port`;
            await ipset.create(localPortSet, "bitmap:port");
            await Block.batchBlock(localPort.split(","), localPortSet);
          } else
            return;
        } else
          return;
        break;
      }

      case "category":
        if (platform.isTLSBlockSupport()) { // default on
          tlsHostSet = categoryUpdater.getHostSetName(target);
        }

        if (["allow", "block", "route"].includes(action)) {
          if (direction !== "inbound" && !localPort && !remotePort) {
            await domainBlock.blockCategory(target, {
              pid,
              scope: scope,
              category: target,
              intfs,
              guids,
              action: action,
              tags,
              parentRgId,
              seq,
              wanUUID,
              routeType
            });
          }
        }
        await categoryUpdater.activateCategory(target);
        if (action === "allow") {
          remoteSet4 = categoryUpdater.getAllowIPSetName(target);
          remoteSet6 = categoryUpdater.getAllowIPSetNameForIPV6(target);
        } else if (policy.dnsmasq_only) {
          // only use static ipset if dnsmasq_only is set
          remoteSet4 = categoryUpdater.getAggrIPSetName(target, true);
          remoteSet6 = categoryUpdater.getAggrIPSetNameForIPV6(target, true);
        } else {
          remoteSet4 = categoryUpdater.getAggrIPSetName(target);
          remoteSet6 = categoryUpdater.getAggrIPSetNameForIPV6(target);
        }
        remoteTupleCount = 2;
        break;

      case "country":
        await countryUpdater.activateCountry(target);
        remoteSet4 = countryUpdater.getIPSetName(countryUpdater.getCategory(target));
        remoteSet6 = countryUpdater.getIPSetNameForIPV6(countryUpdater.getCategory(target));
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

    if (tlsHostSet || tlsHost) {
      let tlsInstalled = true;
      await platform.installTLSModule().catch((err) => {
        log.error(`Failed to install TLS module, will not apply rule ${pid} based on tls`, err.message);
        tlsInstalled = false;
      })

      if (tlsInstalled) {
        // no need to specify remote set 4 & 6 for tls block\
        const tlsCommonArgs = [localPortSet, null, null, remoteTupleCount, remotePositive, remotePortSet, "tcp", action, direction, "create", ctstate, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation];

        await this.__applyRules({ pid, tags, intfs, scope, guids, parentRgId }, tlsCommonArgs).catch((err) => {
          log.error(`Failed to enforce rule ${pid} based on tls`, err.message);
        });

        // activate TLS category after rule is added in iptables, this can guarante hostset is generated in /proc filesystem
        if (tlsHostSet)
          await categoryUpdater.activateTLSCategory(target);
      }
    }

    if (skipFinalApplyRules) {
      return;
    }

    const commonArgs = [localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "create", ctstate, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq, null, null, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation]; // tlsHostSet and tlsHost always null for commonArgs
    await this.__applyRules({ pid, tags, intfs, scope, guids, parentRgId }, commonArgs).catch((err) => {
      log.error(`Failed to enforce rule ${pid} based on ip`, err.message);
    });
  }

  async __applyRules(options, commonArgs) {
    const { pid, tags, intfs, scope, guids, parentRgId } = options || {};

    if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || !_.isEmpty(guids) || !_.isEmpty(parentRgId)) {
      if (!_.isEmpty(tags))
        await Block.setupTagsRules(pid, tags, ...commonArgs);
      if (!_.isEmpty(intfs))
        await Block.setupIntfsRules(pid, intfs, ...commonArgs);
      if (!_.isEmpty(scope))
        await Block.setupDevicesRules(pid, scope, ...commonArgs);
      if (!_.isEmpty(guids))
        await Block.setupGenericIdentitiesRules(pid, guids, ...commonArgs);
      if (!_.isEmpty(parentRgId))
        await Block.setupRuleGroupRules(pid, parentRgId, ...commonArgs);
    } else {
      // apply to global
      await Block.setupGlobalRules(pid, ...commonArgs);
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
    this.invalidateExpireTimer(policy) // invalidate timer if exists
    if (policy.cronTime) {
      // this is a reoccuring policy, use scheduler to manage it
      return scheduler.deregisterPolicy(policy)
    } else if (policy.action == 'screentime') {
      // this is a screentime policy, use screenTime to manage it
      return screenTime.deregisterPolicy(policy);
    } else {
      return this._unenforce(policy) // regular unenforce
    }
  }

  async _unenforce(policy) {
    log.info(`Unenforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, action:${policy.action || "block"}`);

    await this._removeActivatedTime(policy)

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    let { pid, scope, target, action = "block", tag, remotePort, localPort, protocol, direction, upnp, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, owanUUID, origDst, origDport, snatIP, routeType, guids, parentRgId, targetRgId, seq, resolver, flowIsolation } = policy;

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
    const subPrio = this._getRuleSubPriority(type, target);

    if (!seq) {
      seq = Constants.RULE_SEQ_REG;
      if (security)
        seq = Constants.RULE_SEQ_HI;
      if (this._isActiveProtectRule(policy))
        seq = Constants.RULE_SEQ_HI;
      if (this._isInboundAllowRule(policy))
        seq = Constants.RULE_SEQ_LO;
      if (this._isInboundFirewallRule(policy))
        seq = Constants.RULE_SEQ_LO;
    }

    let remoteSet4 = null;
    let remoteSet6 = null;
    let localPortSet = null;
    let remotePortSet = null;
    let remotePositive = true;
    let remoteTupleCount = 1;
    let ctstate = null;
    let tlsHostSet = null;
    let tlsHost = null;
    let qosHandler = null;
    if (localPort) {
      localPortSet = `c_${pid}_local_port`;
      await Block.batchUnblock(localPort.split(","), localPortSet);
    }
    if (remotePort) {
      remotePortSet = `c_${pid}_remote_port`;
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
            await ipset.create(remoteSet4, "hash:ip", true);
            await ipset.create(remoteSet6, "hash:ip", false);
          }
          if (type === "remoteNetPort") {
            remoteSet4 = Block.getDstSet(pid);
            remoteSet6 = Block.getDstSet6(pid);
            await ipset.create(remoteSet4, "hash:net", true);
            await ipset.create(remoteSet6, "hash:net", false);
          }
          await Block.block(values[0], Block.getDstSet(pid));
          remotePort = values[1];
        }

        if (remotePort) {
          remotePortSet = `c_${pid}_remote_port`;
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
          if (direction !== "inbound" && !localPort && !remotePort) {
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
            localPortSet = `c_${pid}_local_port`;
            await Block.batchUnblock(localPort.split(","), localPortSet);
          } else
            return;
        } else
          return;
        break;
      }

      case "category":
        if (platform.isTLSBlockSupport()) { // default on
          tlsHostSet = categoryUpdater.getHostSetName(target);
        }

        if (["allow", "block", "route"].includes(action)) {
          if (direction !== "inbound" && !localPort && !remotePort) {
            await domainBlock.unblockCategory(target, {
              pid,
              scope: scope,
              category: target,
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
        if (action === "allow") {
          remoteSet4 = categoryUpdater.getAllowIPSetName(target);
          remoteSet6 = categoryUpdater.getAllowIPSetNameForIPV6(target);
        } else if (policy.dnsmasq_only) {
          // only use static ipset if dnsmasq_only is set
          remoteSet4 = categoryUpdater.getAggrIPSetName(target, true);
          remoteSet6 = categoryUpdater.getAggrIPSetNameForIPV6(target, true);
        } else {
          remoteSet4 = categoryUpdater.getAggrIPSetName(target);
          remoteSet6 = categoryUpdater.getAggrIPSetNameForIPV6(target);
        }
        remoteTupleCount = 2;
        break;

      case "country":
        remoteSet4 = countryUpdater.getIPSetName(countryUpdater.getCategory(target));
        remoteSet6 = countryUpdater.getIPSetNameForIPV6(countryUpdater.getCategory(target));
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

    const commonArgs = [localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "destroy", ctstate, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq, null, null, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation]; // tlsHostSet and tlsHost always null for commonArgs

    await this.__applyRules({ pid, tags, intfs, scope, guids, parentRgId }, commonArgs).catch((err) => {
      log.error(`Failed to unenforce rule ${pid} based on tls`, err.message);
    });

    if (tlsHostSet || tlsHost) {
      const tlsCommonArgs = [localPortSet, null, null, remoteTupleCount, remotePositive, remotePortSet, "tcp", action, direction, "destroy", ctstate, trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation];
      await this.__applyRules({ pid, tags, intfs, scope, guids, parentRgId }, tlsCommonArgs).catch((err) => {
        log.error(`Failed to unenforce rule ${pid} based on ip`, err.message);
      });
      // refresh activated tls category after rule is removed from iptables, hostset in /proc filesystem will be removed after last reference in iptables rule is removed
      if (tlsHostSet)
        await categoryUpdater.refreshTLSCategoryActivated();
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
    const policies = await this.loadActivePoliciesAsync()

    const matchedPolicies = policies
      .filter(policy =>
        // excludes pbr and qos, lagacy blocking rule might not have action
        (!policy.action || ["allow", "block"].includes(policy.action)) &&
        // low priority rule should not mute alarms
        !this._isInboundAllowRule(policy) &&
        !this._isInboundFirewallRule(policy) &&
        policy.match(alarm)
      )

    if (matchedPolicies.length > 0) {
      log.info('1st matched policy', matchedPolicies[0])
      return true
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
      this.enforceAllPolicies();
    }
  }

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

  _isActiveProtectRule(rule) {
    return rule && rule.type === "category" && rule.target == "default_c" && rule.action == "block";
  }

  _isInboundAllowRule(rule) {
    return rule && rule.direction === "inbound"
      && rule.action === "allow"
      // exclude local rules
      && rule.type !== "intranet" && rule.type !== "network" && rule.type !== "tag" && rule.type !== "device";
  }

  _isInboundFirewallRule(rule) {
    return rule && rule.direction === "inbound"
      && rule.action === "block"
      && (_.isEmpty(rule.target) || rule.target === 'TAG') // TAG was used as a placeholder for internet block
      && _.isEmpty(rule.scope)
      && _.isEmpty(rule.tag)
      && _.isEmpty(rule.guids)
      && (rule.type === 'mac' || rule.type === 'internet')
  }

  _getRuleSubPriority(type, target) {
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

  async _matchLocal(rule, localMac) {
    if (!localMac)
      return false;
    if (rule.scope && rule.scope.length > 0) {
      if (!rule.scope.includes(localMac))
        return false;
    }
    // matching local device group if applicable
    if (rule.tags && rule.tags.length > 0) {
      if (!rule.tags.some(uid => this.ipsetCache[Tag.getTagDeviceMacSetName(uid)] && this.ipsetCache[Tag.getTagDeviceMacSetName(uid)].includes(localMac)))
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
        const domains = await domainBlock.getCategoryDomains(rule.target);
        if (remoteVal && domains.filter(domain => remoteVal === domain || (domain.startsWith("*.") && (remoteVal.endsWith(domain.substring(1)) || remoteVal === domain.substring(2)))).length > 0)
          return true;
        const remoteIPSet4 = categoryUpdater.getIPSetName(rule.target, true);
        const remoteIPSet6 = categoryUpdater.getIPSetNameForIPV6(rule.target, true);
        if ((this.ipsetCache[remoteIPSet4] && this.ipsetCache[remoteIPSet4].some(net => remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(new Address4(net))))) ||
          (this.ipsetCache[remoteIPSet6] && this.ipsetCache[remoteIPSet6].some(net => remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(new Address6(net))))))
          return true;
        if (!rule.dnsmasq_only) {
          const remoteDomainSet4 = categoryUpdater.getIPSetName(rule.target, false);
          const remoteDomainSet6 = categoryUpdater.getIPSetNameForIPV6(rule.target, false);
          if ((this.ipsetCache[remoteDomainSet4] && this.ipsetCache[remoteDomainSet4].some(net => remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(new Address4(net))))) ||
            (this.ipsetCache[remoteDomainSet6] && this.ipsetCache[remoteDomainSet6].some(net => remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(new Address6(net))))))
            return true;
        }

        if (remotePort && protocol) {
          const domainsWithPort = await domainBlock.getCategoryDomainsWithPort(rule.target);
          for (const domainObj of domainsWithPort) {
            if (domainObj.id === remoteVal && domainObj.port.start <= remotePort && remotePort <= domainObj.port.end && domainObj.port.proto === protocol) {
              return true;
            }
          }
          const netportIpset4 = categoryUpdater.getNetPortIPSetName(rule.target);
          const domainportIpset4 = categoryUpdater.getDomainPortIPSetName(rule.target);
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
          
          const netportIpset6 = categoryUpdater.getNetPortIPSetNameForIPV6(rule.target);
          const domainportIpset6 = categoryUpdater.getDomainPortIPSetNameForIPV6(rule.target);
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
        return false;
        break;
      }
      case "country": {
        const remoteSet4 = categoryUpdater.getIPSetName(countryUpdater.getCategory(rule.target));
        const remoteSet6 = categoryUpdater.getIPSetNameForIPV6(countryUpdater.getCategory(rule.target));
        if (!(this.ipsetCache[remoteSet4] && this.ipsetCache[remoteSet4].some(net => remoteIpsToCheck.some(ip => new Address4(ip).isValid() && new Address4(ip).isInSubnet(new Address4(net))))) &&
          !(this.ipsetCache[remoteSet6] && this.ipsetCache[remoteSet6].some(net => remoteIpsToCheck.some(ip => new Address6(ip).isValid() && new Address6(ip).isInSubnet(new Address6(net)))))
        )
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

  async checkACL(localMac, localPort, remoteType, remoteVal = "", remotePort, protocol, direction = "outbound") {
    if (!this.ipsetCache || (this.ipsetCacheUpdateTime && Date.now() / 1000 - this.ipsetCacheUpdateTime > 60)) { // ipset cache becomes invalid after 60 seconds
      this.ipsetCache = await ipset.readAllIpsets() || {};
      this.ipsetCacheUpdateTime = Date.now() / 1000
    }
    if (!this.sortedActiveRulesCache) {
      let activeRules = await this.loadActivePoliciesAsync() || [];
      activeRules = activeRules.filter(rule => !rule.action || ["allow", "block", "match_group"].includes(rule.action) || rule.type === "match_group").filter(rule => (!rule.cronTime || scheduler.shouldPolicyBeRunning(rule)));
      this.sortedActiveRulesCache = activeRules.map(rule => {
        let { scope, target, action = "block", tag, guids } = rule;
        rule.type = rule["i.type"] || rule["type"];
        rule.direction = rule.direction || "bidirection";
        const intfs = [];
        const tags = [];
        if (!_.isEmpty(tag)) {
          let invalid = true;
          for (const tagStr of tag) {
            if (tagStr.startsWith(Policy.INTF_PREFIX)) {
              invalid = false;
              let intfUuid = tagStr.substring(Policy.INTF_PREFIX.length);
              intfs.push(intfUuid);
            } else if (tagStr.startsWith(Policy.TAG_PREFIX)) {
              invalid = false;
              let tagUid = tagStr.substring(Policy.TAG_PREFIX.length);
              tags.push(tagUid);
            }
          }
          if (invalid) {
            rule.rank = -1;
            return rule;
          }
        }

        if (!rule.seq) {
          rule.seq = Constants.RULE_SEQ_REG;
          if (rule.isSecurityBlockPolicy())
            rule.seq = Constants.RULE_SEQ_HI;
          if (this._isActiveProtectRule(rule))
            rule.seq = Constants.RULE_SEQ_HI;
          if (this._isInboundAllowRule(rule))
            rule.seq = Constants.RULE_SEQ_LO;
          if (this._isInboundFirewallRule(rule))
            rule.seq = Constants.RULE_SEQ_LO;
        }

        rule.rank = 6;
        if (scope && scope.length > 0)
          rule.rank = 0;
        if (tags && tags.length > 0)
          rule.rank = 2;
        if (guids && guids.length > 0)
          rule.rank = 2;
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

        if (action === "block")
          // block has lower priority than allow
          rule.rank++;
        if (action === "match_group" || rule.type === "match_group")
          // a trick that makes match_group rule be checked after allow rule and before block rule
          rule.rank += 0.5;
        // high priority rule has a smaller base rank
        if (rule.rank >= 0) {
          switch (rule.seq) {
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
    }

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

    for (const rule of this.sortedActiveRulesCache) {
      // rules in rule group will be checked in match_group rule
      if (rule.parentRgId)
        continue;
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
      if (!await this._matchLocal(rule, localMac))
        continue;

      if (rule.action === "match_group" || rule.type === "match_group") {
        // check rules in the rule group against remote target
        const targetRgId = rule.targetRgId;
        if (!targetRgId)
          continue;
        const subRules = this.sortedActiveRulesCache.filter(r => r.parentRgId === targetRgId); // allow rules come first in the subRules list, the rank should be 8 and 9
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
}

module.exports = PolicyManager2;
