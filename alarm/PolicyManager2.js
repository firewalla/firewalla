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
const initID = 1;

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

const _ = require('lodash')

const delay = require('../util/util.js').delay

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
  'remoteNetPort': 'remote_net_port_set'
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

              await this.unenforce(oldPolicy)
              await this.enforce(policy)
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

    if (policy.expire === '') {
      await rclient.hdelAsync(policyKey, "expire");
    }
    if (policy.cronTime === '') {
      await rclient.hdelAsync(policyKey, "cronTime");
      await rclient.hdelAsync(policyKey, "duration");
    }
    if (policy.activatedTime === '') {
      await rclient.hdelAsync(policyKey, "activatedTime");
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
    if (!policy instanceof Policy) callback(new Error("Not Policy instance"));
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
      this.checkAndSave(policy, (err, resultPolicy) => {
        if (err) {
          reject(err)
        } else {
          resolve(resultPolicy)
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

    return sysManager.isMyServer(target) ||
      // sysManager.myIp() === target ||
      sysManager.isMyIP(target) ||
      sysManager.myIp2() === target ||
      sysManager.isMyMac(target) ||
      // compare mac, ignoring case
      target.substring(0, 17) // devicePort policies have target like mac:protocol:prot
        .localeCompare(sysManager.myMAC(), undefined, { sensitivity: 'base' }) === 0 ||
      target === "firewalla.encipher.com" ||
      target === "firewalla.com" ||
      minimatch(target, "*.firewalla.com")
  }

  async enforce(policy) {
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
    const { type, target, protocol, ip, net, port } = policy
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
    log.info(`Enforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, whitelist:${policy.whitelist}`);

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    await this._refreshActivatedTime(policy)

    if (this.isFirewallaOrCloud(policy)) {
      throw new Error("Firewalla and it's cloud service can't be blocked.")
    }

    let { pid, scope, intf, target, whitelist, tag } = policy

    // tag = []
    // scope !== []
    if (!_.isEmpty(tag)) {
      let invalid = true;
      for (const tagStr of tag) {
        if (tagStr.startsWith(Policy.INTF_PREFIX)) {
          let intfUuid = _.trimStart(tagStr, Policy.INTF_PREFIX);
          let intfInfo = sysManager.getInterfaceViaUUID(intfUuid);
          if (intfInfo && intfInfo.name) {
            invalid = false;
            intf = intfInfo.name;
          } else {
            log.info(`There is no Policy intf:${tagStr} interface info.`)
          }
        }
      }

      // invalid tag should not continue
      if (invalid) {
        return;
      }
    }

    switch (type) {
      case "ip":
      case "net":
      case "remotePort":
      case "remoteIpPort":
      case "remoteNetPort":
        if (scope || intf) {
          await Block.setupRules(pid, pid, ruleSetTypeMap[type], intf, whitelist);
          await Block.addMacToSet(scope, Block.getMacSet(pid));
          await Block.block(target, Block.getDstSet(pid), whitelist)
        } else {
          const set = (whitelist ? 'whitelist_' : 'blocked_') + simpleRuleSetMap[type]

          await Block.block(target, set, whitelist)
        }
        break;

      case "mac":
        await Block.addMacToSet([target], null, whitelist)
        accounting.addBlockedDevice(target);
        break;

      case "domain":
      case "dns":
        // dnsmasq_entry: use dnsmasq instead of iptables
        if (policy.dnsmasq_entry) {
          await dnsmasq.addPolicyFilterEntry([target], {scope, intf}).catch(() => {});
          await dnsmasq.restartDnsmasq()
        }
        else if (scope || intf) {
          await Block.setupRules(pid, pid, "hash:ip", intf, whitelist);
          await Block.addMacToSet(scope, Block.getMacSet(pid));
          await domainBlock.blockDomain(target, {
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(pid),
            scope: scope,
            intf: intf
          })
        } else {
          const options = { exactMatch: policy.domainExactMatch };
          if (whitelist) {
            options.blockSet = "whitelist_domain_set";
            // whitelist rule should not add dnsmasq filter rule
          }
          await domainBlock.blockDomain(target, options);
          // await Block.setupRules(null, pid, "hash:ip", intf, whitelist);
        }
        break;

      case "devicePort": {
        let data = await this.parseDevicePortRule(target);
        if (data) {
          if (whitelist) {
            await Block.blockPublicPort(data.ip, data.port, data.protocol, "whitelist_ip_port_set");
          } else {
            await Block.blockPublicPort(data.ip, data.port, data.protocol)
          }
        }
        break;
      }

      case "category":
        if (policy.dnsmasq_entry) {
          await domainBlock.blockCategory(target, {
            scope: scope,
            category: target,
            intf: intf
          });
        } else {
          await Block.setupRules((scope || intf) && pid, target, "hash:ip", intf, whitelist);
          if (scope) await Block.addMacToSet(scope, Block.getMacSet(pid));
          if (!scope && !whitelist && target === 'default_c') try {
            await categoryUpdater.iptablesRedirectCategory(target)
          } catch (err) {
            log.error("Failed to redirect default_c traffic", err)
          }
        }
        break;

      case "country":
        await countryUpdater.activateCountry(target);
        await Block.setupRules((scope || intf) && pid, countryUpdater.getCategory(target), "hash:net", intf, whitelist);
        await Block.addMacToSet(scope, Block.getMacSet(pid));
        break;

      default:
        throw new Error("Unsupported policy type");
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
    log.info(`Unenforce policy pid:${policy.pid}, type:${policy.type}, target:${policy.target}, scope:${policy.scope}, tag:${policy.tag}, whitelist:${policy.whitelist}`);

    await this._removeActivatedTime(policy)

    const type = policy["i.type"] || policy["type"]; //backward compatibility

    let { pid, scope, intf, target, whitelist, tag } = policy

    if (!_.isEmpty(tag)) {
      let invalid = true;
      for (const tagStr of tag) {
        if (tagStr.startsWith(Policy.INTF_PREFIX)) {
          let intfUuid = _.trimStart(tagStr, Policy.INTF_PREFIX);
          let intfInfo = sysManager.getInterfaceViaUUID(intfUuid);
          if (intfInfo && intfInfo.name) {
            invalid = false;
            intf = intfInfo.name;
          } else {
            log.info(`There is no Policy intf:${tagStr} interface info.`)
          }
        }
      }

      // invalid tag should not continue
      if (invalid) {
        return;
      }
    }

    switch (type) {
      case "ip":
      case "net":
      case "remotePort":
      case "remoteIpPort":
      case "remoteNetPort":
        if (scope || intf) {
          await Block.setupRules(pid, pid, ruleSetTypeMap[type], intf, whitelist, true);
        } else {
          const set = (whitelist ? 'whitelist_' : 'blocked_') + simpleRuleSetMap[type]

          await Block.unblock(target, set, whitelist)
        }
        break;

      case "mac":
        await Block.delMacFromSet([target], null, whitelist)
        accounting.removeBlockedDevice(target);
        break;

      case "domain":
      case "dns":
        // dnsmasq_entry: use dnsmasq instead of iptables
        if (policy.dnsmasq_entry) {
          await dnsmasq.removePolicyFilterEntry([target], {scope, intf}).catch(() => {});
          await dnsmasq.restartDnsmasq()
        }
        else if (scope || intf) {
          await domainBlock.unblockDomain(target, {
            exactMatch: policy.domainExactMatch,
            blockSet: Block.getDstSet(pid),
            scope: scope,
            intf: intf
          })
          // destroy domain dst cache, since there may be various domain dst cache in different policies
          await Block.setupRules(pid, pid, 'hash:ip', intf, whitelist, true);
        } else {
          const options = { exactMatch: policy.domainExactMatch };
          if (whitelist) {
            options.blockSet = "whitelist_domain_set";
          }
          await domainBlock.unblockDomain(target, options);
        }
        break;

      case "devicePort": {
        let data = await this.parseDevicePortRule(target)
        if (data) {
          if (whitelist) {
            await Block.unblockPublicPort(data.ip, data.port, data.protocol, "whitelist_ip_port_set");
          } else {
            await Block.unblockPublicPort(data.ip, data.port, data.protocol);
          }
        }
        break;
      }

      case "category":
        if (policy.dnsmasq_entry) {
          await domainBlock.unblockCategory(target, {
            scope: scope,
            category: target,
            intf: intf
          });
        } else {
          await Block.setupRules((scope || intf) && pid, target, 'hash:ip', intf, whitelist, true, false);
          if (!scope && !whitelist && target === 'default_c') try {
            await categoryUpdater.iptablesUnredirectCategory(target)
          } catch (err) {
            log.error("Failed to redirect default_c traffic", err)
          }
        }
        break;

      case "country":
        await Block.setupRules((scope || intf) && pid, countryUpdater.getCategory(target), 'hash:net', intf, whitelist, true, false);
        break;

      default:
        throw new Error("Unsupported policy");
    }
  }

  match(alarm, callback) {
    this.loadActivePolicies((err, policies) => {
      if (err) {
        log.error("Failed to load active policy rules")
        callback(err)
        return
      }

      const matchedPolicies = policies.filter((policy) => {
        return policy.match(alarm)
      })

      if (matchedPolicies.length > 0) {
        callback(null, true)
      } else {
        callback(null, false)
      }
    })
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
}

module.exports = PolicyManager2;
