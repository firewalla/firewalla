/*    Copyright 2016-2020 Firewalla Inc.
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

let instance = null;

const policyActiveKey = "policy_active";

const policyIDKey = "policy:id";
const policyPrefix = "policy:";
const policyDisableAllKey = "policy:disable:all";
const initID = 1;
const {Address4, Address6} = require('ip-address');
const Host = require('../net2/Host.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Block = require('../control/Block.js');

const Policy = require('./Policy.js');

const HostTool = require('../net2/HostTool.js')
const ht = new HostTool()

const DomainIPTool = require('../control/DomainIPTool.js');
const domainIPTool = new DomainIPTool();

const domainBlock = require('../control/DomainBlock.js')();

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()
const CountryUpdater = require('../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

const scheduler = require('../extension/scheduler/scheduler.js')()

const Queue = require('bee-queue')

const platform = require('../platform/PlatformLoader.js').getPlatform();
const policyCapacity = platform.getPolicyCapacity();

const Accounting = require('../control/Accounting.js');
const accounting = new Accounting();

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const Tag = require('../net2/Tag.js');
const ipset = require('../net2/Ipset.js');

const _ = require('lodash');

const delay = require('../util/util.js').delay;
const validator = require('validator');
const iptool = require('ip');
const util = require('util');
const exec = require('child-process-promise').exec;
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();

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
            return
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
            return
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
            return
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
            return
          }
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
          job.timeout(60 * 1000).save(function () { })
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

    Object.assign(existing, policy);

    if (existing.target && existing.type) {
      switch (existing.type) {
        case "mac":
          existing.target = existing.target.toUpperCase(); // always upper case for mac address
          break;
        case "dns":
        case "domain":
          existing.target = existing.target.toLowerCase(); // always lower case for domain block
          break;
        default:
        // do nothing;
      }
    }

    await rclient.hmsetAsync(policyKey, existing.redisfy());

    const emptyStringCheckKeys = ["expire", "cronTime", "duration", "activatedTime", "remote", "remoteType", "local", "localType", "localPort", "remotePort", "proto"];

    for (const key of emptyStringCheckKeys) {
      if (policy[key] === '')
        await rclient.hdelAsync(policyKey, key);
    }

    if (policy.hasOwnProperty('scope') && _.isEmpty(policy.scope)) {
      await rclient.hdelAsync(policyKey, "scope");
    }
    if (policy.hasOwnProperty('tag') && _.isEmpty(policy.tag)) {
      await rclient.hdelAsync(policyKey, "tag");
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
      if (this.isFirewallaOrCloud(policy)) {
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
          resolve({policy, alreadyExists})
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

  deletePolicy(policyID) {
    log.info("Trying to delete policy " + policyID);
    return this.policyExists(policyID)
      .then((exists) => {
        if (!exists) {
          log.error("policy " + policyID + " doesn't exists");
          return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
          let multi = rclient.multi();

          multi.zrem(policyActiveKey, policyID);
          multi.del(policyPrefix + policyID);
          multi.exec((err) => {
            if (err) {
              log.error("Fail to delete policy: " + err);
              reject(err);
              return;
            }

            resolve();
          })
        });
      });
  }

  // await all async opertions here to ensure errors are caught
  async deleteMacRelatedPolicies(mac) {
    // device specified policy
    await rclient.delAsync('policy:mac:' + mac);

    let rules = await this.loadActivePoliciesAsync({ includingDisabled: 1 })
    let policyIds = [];
    let policyKeys = [];

    for (let rule of rules) {
      if (rule.type == 'mac' && rule.target == mac) {
        policyIds.push(rule.pid);
        policyKeys.push('policy:' + rule.pid);
        this.tryPolicyEnforcement(rule, 'unenforce');
      }

      if (_.isEmpty(rule.scope)) continue;

      if (rule.scope.some(m => m == mac)) {
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
      }
    }

    if (policyIds.length) { // policyIds & policyKeys should have same length
      await rclient.delAsync(policyKeys);
      await rclient.zremAsync(policyActiveKey, policyIds);
    }
    log.info('Deleted', mac, 'related policies:', policyKeys);
  }

  async deleteTagRelatedPolicies(tag) {
    // device specified policy
    await rclient.delAsync('policy:tag:' + tag);

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
      await rclient.delAsync(policyKeys);
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
          callback(err, err ? [] : policyRules.filter((r) => r.disabled != "1")) // remove all disabled one
        }
      });
    });
  }

  // cleanup before use
  async cleanupPolicyData() {
    await domainIPTool.removeAllDomainIPMapping()
  }

  async enforceAllPolicies() {
    const rules = await this.loadActivePoliciesAsync();

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

    log.info("All policy rules are enforced")

    sem.emitEvent({
      type: 'Policy:AllInitialized',
      toProcess: 'FireMain', //make sure firemain process handle enforce policy event
      message: 'All policies are enforced'
    })
  }


  async parseDevicePortRule(target) {
    let matches = target.match(/(.*):(\d+):(tcp|udp)/)
    if (matches) {
      let mac = matches[1];
      let host = await ht.getMACEntry(mac);
      if (host) {
        return {
          mac: mac,
          ip: host.ipv4Addr,
          port: matches[2],
          protocol: matches[3]
        }
      } else {
        return null
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
      target === "firewalla.encipher.com" ||
      target === "firewalla.com" ||
      minimatch(target, "*.firewalla.com"))
  }

  async enforce(policy) {
    if (await this.isDisableAll()) {
      return policy; // temporarily by DisableAll flag
    }

    if (policy.disabled == 1) {
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
      activatedTime: now
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

  async _enforce(policy) {
    log.info(`Enforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, action:${policy.action || "block"}`);

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    await this._refreshActivatedTime(policy)

    if (this.isFirewallaOrCloud(policy)) {
      throw new Error("Firewalla and it's cloud service can't be blocked.")
    }

    let { pid, scope, target, action = "block", tag, remotePort, localPort, protocol, direction, upnp} = policy;

    if (action !== "block" && action !== "allow") {
      log.error(`Unsupported action ${action} for policy ${pid}`);
      return;
    }

    // tag = []
    // scope !== []
    let intfs = [];
    let tags = [];
    if (!_.isEmpty(tag)) {
      let invalid = true;
      for (const tagStr of tag) {
        if (tagStr.startsWith(Policy.INTF_PREFIX)) {
          invalid = false;
          let intfUuid = tagStr.substring(Policy.INTF_PREFIX.length);
          intfs.push(intfUuid);
        } else if(tagStr.startsWith(Policy.TAG_PREFIX)) {
          invalid = false;
          let tagUid = tagStr.substring(Policy.TAG_PREFIX.length);
          tags.push(tagUid);
        }
      }

      // invalid tag should not continue
      if (invalid) {
        log.error(`Unknown policy tags format policy id: ${pid}, stop enforce policy`);
        return;
      }
    }

    let remoteSet4 = null;
    let remoteSet6 = null;
    let localPortSet = null;
    let remotePortSet = null;
    let remotePositive = true;
    let remoteTupleCount = 1;
    let ctstate = null;
    if (localPort) {
      localPortSet = `c_${pid}_local_port`;
      await ipset.create(localPortSet, "bitmap:port");
      await Block.block(localPort, localPortSet);
    }
    if (remotePort) {
      remotePortSet = `c_${pid}_remote_port`;
      await ipset.create(remotePortSet, "bitmap:port");
      await Block.block(remotePort, remotePortSet);
    }

    if (upnp) {
      direction = "inbound";
      ctstate = "DNAT";
    }
    
    switch (type) {
      case "ip":
      case "net": {
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || localPortSet || remotePortSet) {
          await ipset.create(remoteSet4, ruleSetTypeMap[type], true);
          await ipset.create(remoteSet6, ruleSetTypeMap[type], false);
          await Block.block(target, Block.getDstSet(pid));
        } else {
          // apply to global without specified src/dst port, directly add to global ip or net allow/block set
          const set = (action === "allow" ? 'allow_' : 'block_') + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : "")) + simpleRuleSetMap[type];
          // Block.block will distribute IPv4/IPv6 to corresponding ipset, additional '6' will be added to set name for IPv6 ipset
          await Block.block(target, set);
          return;
        }
        break;
      }
      case "remotePort":
      case "remoteIpPort":
      case "remoteNetPort":
        const values = (target && target.split(',')) || [];
        if (values.length == 2) {
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
        } else
          remotePort = values[0] || null;
        
        if (remotePort) {
          remotePortSet = `c_${pid}_remote_port`;
          await ipset.create(remotePortSet, "bitmap:port");
          await Block.block(remotePort, remotePortSet);
        }
        break;

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
        break;
      case "domain":
      case "dns":
        if (direction !== "inbound") {
          await dnsmasq.addPolicyFilterEntry([target], { pid, scope, intfs, tags, action }).catch(() => { });
          dnsmasq.scheduleRestartDNSService();
        }
        if (policy.dnsmasq_only)
          return;
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || localPortSet || remotePortSet) {
          await ipset.create(remoteSet4, "hash:ip", true);
          await ipset.create(remoteSet6, "hash:ip", false);
          await domainBlock.blockDomain(target, {
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(pid)
          });
        } else {
          const set = (action === "allow" ? 'allow_' : 'block_') + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : "")) + simpleRuleSetMap[type];
          await domainBlock.blockDomain(target, {
            exactMatch: policy.domainExactMatch,
            blockSet: set
          });
          return;
        }
        break;

      // target format host:mac:proto, ONLY support single host
      // do not support scope || tags || intfs
      case "devicePort": {
        let data = await this.parseDevicePortRule(target);
        if (data && data.mac) {
          protocol = data.protocol;
          localPort = data.port;
          scope = [data.mac];

          if (localPort) {
            localPortSet = `c_${pid}_local_port`;
            await ipset.create(localPortSet, "bitmap:port");
            await Block.block(localPort, localPortSet);
          } else
            return; 
        } else
          return;
        break;
      }

      case "category":
        /* TODO: support dnsmasq on category
        await domainBlock.blockCategory(target, {
          pid,
          scope: scope,
          category: target,
          intfs,
          tags
        });
        */
        if (policy.dnsmasq_only)
          return;
        await categoryUpdater.activateCategory(target);
        remoteSet4 = categoryUpdater.getIPSetName(target);
        remoteSet6 = categoryUpdater.getIPSetNameForIPV6(target);
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
        // target is device mac address
        await Host.ensureCreateDeviceIpset(target);
        remoteSet4 = Host.getDeviceSetName(target);
        remoteSet6 = Host.getDeviceSetName(target);
        break;

      default:
        throw new Error("Unsupported policy type");
    }

    if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope)) {
      if (!_.isEmpty(tags))
        await Block.setupTagsRules(pid, tags, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "create", ctstate);
      if (!_.isEmpty(intfs))
        await Block.setupIntfsRules(pid, intfs, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "create", ctstate);
      if (!_.isEmpty(scope))
        await Block.setupDevicesRules(pid, scope, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "create", ctstate);
    } else {
      // apply to global
      await Block.setupGlobalRules(pid, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "create", ctstate);
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
    if (policy.cronTime) {
      // this is a reoccuring policy, use scheduler to manage it
      return scheduler.deregisterPolicy(policy)
    } else {
      this.invalidateExpireTimer(policy) // invalidate timer if exists
      return this._unenforce(policy) // regular unenforce
    }
  }

  async _unenforce(policy) {
    log.info(`Unenforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, action:${policy.action || "block"}`);

    await this._removeActivatedTime(policy)

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    let { pid, scope, target, action = "block", tag, remotePort, localPort, protocol, direction, upnp} = policy;

    if (action !== "block" && action !== "allow") {
      log.error(`Unsupported action ${action} for policy ${pid}`);
      return;
    }

    let intfs = [];
    let tags = [];
    if (!_.isEmpty(tag)) {
      let invalid = true;
      for (const tagStr of tag) {
        if (tagStr.startsWith(Policy.INTF_PREFIX)) {
          invalid = false;
          let intfUuid = tagStr.substring(Policy.INTF_PREFIX.length);
          intfs.push(intfUuid);
        } else if(tagStr.startsWith(Policy.TAG_PREFIX)) {
          invalid = false
          let tagUid = tagStr.substring(Policy.TAG_PREFIX.length);;
          tags.push(tagUid);
        }
      }

      // invalid tag should not continue
      if (invalid) {
        log.error(`Unknown policy tags format policy id: ${pid}, stop unenforce policy`);
        return;
      }
    }

    let remoteSet4 = null;
    let remoteSet6 = null;
    let localPortSet = null;
    let remotePortSet = null;
    let remotePositive = true;
    let remoteTupleCount = 1;
    let ctstate = null;
    if (localPort) {
      localPortSet = `c_${pid}_local_port`;
      await Block.unblock(localPort, localPortSet);
    }
    if (remotePort) {
      remotePortSet = `c_${pid}_remote_port`;
      await Block.unblock(remotePort, remotePortSet);
    }

    if (upnp) {
      direction = "inbound";
      ctstate = "DNAT";
    }

    switch (type) {
      case "ip":
      case "net": {
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope) || localPortSet || remotePortSet) {
          await Block.unblock(target, Block.getDstSet(pid));
        } else {
          const set = (action === "allow" ? 'allow_' : 'block_') + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : "")) + simpleRuleSetMap[type];
          await Block.unblock(target, set);
          return;
        }
        break;
      }
      case "remotePort":
      case "remoteIpPort":
      case "remoteNetPort":
        const values = (target && target.split(',')) || [];
        if (values.length == 2) {
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
        } else
          remotePort = values[0] || null;

        if (remotePort) {
          remotePortSet = `c_${pid}_remote_port`;
          await Block.unblock(remotePort, remotePortSet);
        }
        break;

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
        break;
      case "domain":
      case "dns":
        if (direction !== "inbound") {
          await dnsmasq.removePolicyFilterEntry([target], { pid, scope, intfs, tags, action }).catch(() => { });
          dnsmasq.scheduleRestartDNSService();
        }
        if (policy.dnsmasq_only)
          return;
        remoteSet4 = Block.getDstSet(pid);
        remoteSet6 = Block.getDstSet6(pid);
        if (!_.isEmpty(tags) || !_.isEmpty(scope) || !_.isEmpty(intfs) || localPortSet || remotePortSet) {
          await domainBlock.unblockDomain(target, {
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(pid)
          });
        } else {
          const set = (action === "allow" ? 'allow_' : 'block_') + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : "")) + simpleRuleSetMap[type];
          await domainBlock.unblockDomain(target, {
            exactMatch: policy.domainExactMatch,
            blockSet: set
          });
          return;
        }
        break;

      case "devicePort": {
        let data = await this.parseDevicePortRule(target)
        if (data && data.mac) {
          protocol = data.protocol;
          localPort = data.port;
          scope = [data.mac];

          if (localPort) {
            localPortSet = `c_${pid}_local_port`;
            await Block.unblock(localPort, localPortSet);
          } else
            return;
        } else
          return;
        break;
      }

      case "category":
        /* TODO: support dnsmasq on category
        await domainBlock.unblockCategory(target, {
          pid,
          scope: scope,
          category: target,
          intfs,
          tags
        });
        */
        if (policy.dnsmasq_only)
          return;
        remoteSet4 = categoryUpdater.getIPSetName(target);
        remoteSet6 = categoryUpdater.getIPSetNameForIPV6(target);
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
        // target is device mac address
        await Host.ensureCreateDeviceIpset(target);
        remoteSet4 = Host.getDeviceSetName(target);
        remoteSet6 = Host.getDeviceSetName(target);
        break;

      default:
        throw new Error("Unsupported policy");
    }

    if (!_.isEmpty(tags) || !_.isEmpty(intfs) || !_.isEmpty(scope)) {
      if (!_.isEmpty(tags))
        await Block.setupTagsRules(pid, tags, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "destroy", ctstate);
      if (!_.isEmpty(intfs))
        await Block.setupIntfsRules(pid, intfs, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "destroy", ctstate);
      if (!_.isEmpty(scope))
        await Block.setupDevicesRules(pid, scope, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "destroy", ctstate);
    } else {
      // apply to global
      await Block.setupGlobalRules(pid, localPortSet, remoteSet4, remoteSet6, remoteTupleCount, remotePositive, remotePortSet, protocol, action, direction, "destroy", ctstate);
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
        await ipset.flush(remoteSet4);
        await ipset.destroy(remoteSet4);
      }
    }
    if (remoteSet6) {
      if (type === "ip" || type === "net" || type === "remoteIpPort" || type === "remoteNetPort" || type === "domain" || type === "dns") {
        await ipset.flush(remoteSet6);
        await ipset.destroy(remoteSet6);
      }
    }
  }

  async match(alarm) {
    const policies = await this.loadActivePoliciesAsync()

    const matchedPolicies = policies.filter(policy => policy.match(alarm))

    if(matchedPolicies.length > 0) {
      log.debug('1st matched policy', matchedPolicies[0])
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
      if (addrPort.length == 2){
        waitSearch.push(addrPort[1]);
        for (const address of addresses) {
          waitSearch.push(address + "," + addrPort[1]); // for ipset test command
        }
      }
    } else {
      waitSearch.push(addr);
      if (addrPort.length == 2){
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
      let cmdResult = await exec("sudo iptables -S | grep -E 'FW_FIREWALL'");
      let iptableFW = cmdResult.stdout.toString().trim(); // iptables content
      cmdResult = await exec(`sudo ipset -S`);
      let cmdResultContent = cmdResult.stdout.toString().trim().split('\n');
      for (const line of cmdResultContent) {
        const splitCurrent = line.split(" ");
        if (splitCurrent[0] == "create") {
          // ipset name
          if (iptableFW.indexOf(' ' + splitCurrent[1] + ' ') > -1) {
            // ipset name in iptables
            ipsets.push({ipsetName: splitCurrent[1], ipsetType: splitCurrent[2]});
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
        } else if (ipsetName == "block_ip_set" && iptool.isV4Format(currentTxt)) {
          matchedRules = rules.filter(rule => rule.type == "ip" && rule.target === currentTxt);
        } else if (ipsetName == "block_net_set" && iptool.isV4Format(currentTxt)) {
          matchedRules = rules.filter(rule => rule.type == "net" && iptool.cidrSubnet(rule.target).contains(currentTxt));
        } else if (ipsetName == "block_domain_set" && iptool.isV4Format(currentTxt)) {
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
              if (Number.isInteger(Number(portStart)) && Number.isInteger(Number(portEnd)) && Number(currentTxt) >= Number(portStart) && Number(currentTxt) <= Number(portEnd) ) {
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
                  crossIps.push({ip: currentTxt, domain: domain, pid: matchedRule.pid});
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

    const unEnforcement = rules.map((rule) => {
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
}

module.exports = PolicyManager2;
