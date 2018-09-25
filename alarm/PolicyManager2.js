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

const log = require('../net2/logger.js')(__filename, 'info');

const redis = require('redis');
const rclient = require('../util/redis_manager.js').getRedisClient()

let flat = require('flat');

let audit = require('../util/audit.js');
let util = require('util');
let Bone = require('../lib/Bone.js');

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const Promise = require('bluebird');

const minimatch = require('minimatch')

const SysManager = require('../net2/SysManager.js')
const sysManager = new SysManager('info');

let instance = null;

let policyActiveKey = "policy_active";

let policyIDKey = "policy:id";
let policyPrefix = "policy:";
let initID = 1;

let sem = require('../sensor/SensorEventManager.js').getInstance();

let extend = require('util')._extend;

let Block = require('../control/Block.js');

let Policy = require('./Policy.js');

const HostTool = require('../net2/HostTool.js')
const ht = new HostTool()

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const domainBlock = require('../control/DomainBlock.js')()

const categoryBlock = require('../control/CategoryBlock.js')()

const scheduler = require('../extension/scheduler/scheduler.js')()

const Queue = require('bee-queue')

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
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

  setupPolicyQueue() {
    this.queue = new Queue('policy', {
      removeOnFailure: true,
      removeOnSuccess: true
    });

    this.queue.on('error', (err) => {
      log.error("Queue got err:", err)
    })

    this.queue.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${job.name} failed with error ${err.message}`);
    });

    this.queue.destroy(() => {
      log.info("policy queue is cleaned up")
    })

    this.queue.process((job, done) => {
      const event = job.data
      const policy = this.jsonToPolicy(event.policy)
      const oldPolicy = this.jsonToPolicy(event.oldPolicy)
      const action = event.action
      
      switch(action) {
      case "enforce": {
        return async(() => {
          log.info("START ENFORCING POLICY", policy.pid, action, {})
          await(this.enforce(policy))
        })().catch((err) => {
          log.error("enforce policy failed:" + err)
        }).finally(() => {
          log.info("COMPLETE ENFORCING POLICY", policy.pid, action, {})
          done()
        })
        break
      }

      case "unenforce": {
        return async(() => {
          log.info("START UNENFORCING POLICY", policy.pid, action, {})
          await(this.unenforce(policy))
        })().catch((err) => {
          log.error("unenforce policy failed:" + err)
        }).finally(() => {
          log.info("COMPLETE UNENFORCING POLICY", policy.pid, action, {})
          done()
        })
        break
      }

      case "reenforce": {
        return async(() => {
          if(!oldPolicy) {
            // do nothing
          } else {
            log.info("START REENFORCING POLICY", policy.pid, action, {})

            await(this.unenforce(oldPolicy))
            await(this.enforce(policy))
          }
        })().catch((err) => {
          log.error("unenforce policy failed:" + err)
        }).finally(() => {
          log.info("COMPLETE ENFORCING POLICY", policy.pid, action, {})
          done()
        })
        break
      }

      case "incrementalUpdate": {
        return async(() => {
          const list = await (domainBlock.getAllIPMappings())
          list.forEach((l) => {
            const matchDomain = l.match(/ipmapping:domain:(.*)/)
            if(matchDomain) {
              const domain = matchDomain[1]
              await (domainBlock.incrementalUpdateIPMapping(domain, {}))
              return
            } 
            
            const matchExactDomain = l.match(/ipmapping:exactdomain:(.*)/)
            if(matchExactDomain) {
              const domain = matchExactDomain[1]
              await (domainBlock.incrementalUpdateIPMapping(domain, {exactMatch: 1}))
              return
            }
          })
        })().catch((err) => {
          log.error("incremental update policy failed:", err, {})
        }).finally(() => {
          log.info("COMPLETE incremental update policy", {})
          done()
        })
      }

      default:
        log.error("unrecoganized policy enforcement action:" + action)
        done()
        break
      }
    })

    setInterval(() => {
      this.queue.checkHealth((error, counts) => {
        log.debug("Policy queue status:", counts, {})
      })
      
    }, 60 * 1000)
  }

  registerPolicyEnforcementListener() { // need to ensure it's serialized
    log.info("register policy enforcement listener")
    sem.on("PolicyEnforcement", (event) => {
      if (event && event.policy) {
        log.info("got policy enforcement event:" + event.action + ":" + event.policy.pid)
        if(this.queue) {
          const job = this.queue.createJob(event)
          job.timeout(60 * 1000).save(function() {})
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
        action : action, //'enforce', 'unenforce', 'reenforce'
        policy : policy,
        oldPolicy: oldPolicy
      })
    }
  }

  createPolicyIDKey(callback) {
    rclient.set(policyIDKey, initID, callback);
  }

  getNextID(callback) {
    rclient.get(policyIDKey, (err, result) => {
      if(err) {
        log.error("Failed to get policyIDKey: " + err);
        callback(err);
        return;
      }

      if(result) {
        rclient.incr(policyIDKey, (err, newID) => {
          if(err) {
            log.error("Failed to incr policyIDKey: " + err);
          }
          callback(null, newID);
        });
      } else {
        this.createPolicyIDKey((err) => {
          if(err) {
            log.error("Failed to create policyIDKey: " + err);
            callback(err);
            return;
          }

          rclient.incr(policyIDKey, (err) => {
            if(err) {
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
      if(err) {
        log.error("Failed to add policy to active queue: " + err);
      }
      callback(err);
    });
  }

  createPolicyFromJson(json, callback) {
    callback = callback || function() {}    

    callback(null, this.jsonToPolicy(json));
  }

  createPolicy(json) {
    return this.jsonToPolicy(json)
  }

  normalizePoilcy(policy) {
    // convert array to string so that redis can store it as value
    if(policy.scope && policy.scope.constructor.name === 'Array') {
      policy.scope = JSON.stringify(policy.scope)
    }    
  }

  updatePolicyAsync(policy) {
    const pid = policy.pid
    if(pid) {
      const policyKey = policyPrefix + pid;
      return async(() => {
        const policyCopy = JSON.parse(JSON.stringify(policy))

        this.normalizePoilcy(policyCopy);

        await (rclient.hmsetAsync(policyKey, flat.flatten(policyCopy)))

        if(policyCopy.expire === "" || ! "expire" in policyCopy) {
          await (rclient.hdelAsync(policyKey, "expire"))
        }
        if(policyCopy.cronTime === "" || ! "cronTime" in policyCopy) {
          await (rclient.hdelAsync(policyKey, "cronTime"))
          await (rclient.hdelAsync(policyKey, "duration"))
        }
        if(policyCopy.activatedTime === "" || ! "activatedTime" in policyCopy) {
          await (rclient.hdelAsync(policyKey, "activatedTime"))
        }
        
        if(policyCopy.scope === "" || 
        ! "scope" in policyCopy || 
        (policyCopy.constructor.name === 'Array' && policy.length === 0)) {
          await (rclient.hdelAsync(policyKey, "scope"))
        }
      })()
    } else {
      return Promise.reject(new Error("UpdatePolicyAsync requires policy ID"))
    }
  }

  savePolicyAsync(policy) {
    return new Promise((resolve, reject) => {
      this.savePolicy(policy, (err) => {
        if(err)
          reject(err);

        resolve();
      })
    })
  }
  savePolicy(policy, callback) {
    callback = callback || function() {}

    log.info("In save policy:", policy);

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      policy.pid = id + ""; // convert to string

      let policyKey = policyPrefix + id;

      const policyCopy = JSON.parse(JSON.stringify(policy))

      this.normalizePoilcy(policyCopy);
    
      rclient.hmset(policyKey, flat.flatten(policyCopy), (err) => {
        if(err) {
          log.error("Failed to set policy: " + err);
          callback(err);
          return;
        }

        this.addToActiveQueue(policy, (err) => {
          if(!err) {
            audit.trace("Created policy", policy.pid);
          }
          this.tryPolicyEnforcement(policy)
          callback(null, policy)
        });

        Bone.submitIntelFeedback('block', policy, 'policy');
      });
    });
  }

  checkAndSave(policy, callback) {
    callback = callback || function() {}
    async(()=>{
      //FIXME: data inconsistence risk for multi-processes or multi-threads
      try {
        if(this.isFirewallaCloud(policy)) {
          callback(new Error("Firewalla cloud can't be blocked"))
          return
        }
        let policies = await(this.getSamePolicies(policy))
        if (policies && policies.length > 0) {
          log.info("policy with type:" + policy.type + ",target:" + policy.target + " already existed")
          const samePolicy = policies[0]
          if(samePolicy.disabled && samePolicy.disabled == "1") {
            // there is a policy in place and disabled, just need to enable it
            await (this.enablePolicy(samePolicy))
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
    })()
  }

  checkAndSaveAsync(policy) {
    return new Promise((resolve, reject) => {
      this.checkAndSave(policy, (err, resultPolicy) => {
        if(err) {
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
        if(err) {
          reject(err);
          return;
        }

        resolve(result !== null);
      });
    });
  }

  getPolicy(policyID) {
    return new Promise((resolve, reject) => {
      this.idsToPolicys([policyID], (err, results) => {
        if(err) {
          reject(err);
          return;
        }

        if(results == null || results.length === 0) {
          resolve(null)
          return
        }

        resolve(results[0]);
      });
    });
  }

  getSamePolicies(policy) {
    let pm2 = this
    return async(() => {
      return new Promise(function (resolve, reject) {
        pm2.loadActivePolicys(1000, {
          includingDisabled: true
        }, (err, policies)=>{
          if (err) {
            log.error("failed to load active policies:" + err)
            reject(err)
          } else {
            if (policies) {
              resolve(policies.filter((p) => policy.isEqualToPolicy(p)))
            } else {
              resolve([])
            }
          }    
        })
      })
    })();
  }

  // These two enable/disable functions are intended to be used by all nodejs processes, not just FireMain
  // So cross-process communication is used
  // the real execution is on FireMain, check out _enablePolicy and _disablePolicy below
  enablePolicy(policy) {
    return async(() => {
      if(policy.disabled != '1') {
        return policy // do nothing, since it's already enabled
      }
      await (this._enablePolicy(policy))
      this.tryPolicyEnforcement(policy, "enforce")
      Bone.submitIntelFeedback('enable', policy, 'policy')      
      return policy
    })()
  }

  disablePolicy(policy) {
    return async(() => {
      if(policy.disabled == '1') {
        return // do nothing, since it's already disabled
      }
      await (this._disablePolicy(policy))
      this.tryPolicyEnforcement(policy, "unenforce")
      Bone.submitIntelFeedback('disable', policy, 'policy')
    })()
  }

  disableAndDeletePolicy(policyID) {
    return async(() => {
      let policy = await (this.getPolicy(policyID))

      if(!policy) {
        return Promise.resolve()
      }

      await (this.deletePolicy(policyID)) // delete before broadcast

      this.tryPolicyEnforcement(policy, "unenforce")
      Bone.submitIntelFeedback('unblock', policy, 'policy');
    })()
  }

  deletePolicy(policyID) {
    log.info("Trying to delete policy " + policyID);
    return this.policyExists(policyID)
      .then((exists) => {
        if(!exists) {
          log.error("policy " + policyID + " doesn't exists");
          return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
          let multi = rclient.multi();

          multi.zrem(policyActiveKey, policyID);
          multi.del(policyPrefix + policyID);
          multi.exec((err) => {
            if(err) {
              log.error("Fail to delete policy: " + err);
              reject(err);
              return;
            }

            resolve();
          })
        });
      });
  }

  jsonToPolicy(json) {
    if(!json) {
      return null;
    }

    let proto = Policy.prototype;
    if(proto) {
      let obj = Object.assign(Object.create(proto), json);
      if(!obj.timestamp)
        obj.timestamp = new Date() / 1000;
      return obj;
    } else {
      log.error("Unsupported policy type: " + json.type);
      return null;
    }
  }

    idsToPolicys(ids, callback) {
      let multi = rclient.multi();

      ids.forEach((pid) => {
        multi.hgetall(policyPrefix + pid);
      });

      multi.exec((err, results) => {
        if(err) {
          log.error("Failed to load active policys (hgetall): " + err);
          callback(err);
          return;
        }
        
        let rr = results.map((r) => {
          if(r && r.scope && r.scope.constructor.name === 'String') {
            try {
              r.scope = JSON.parse(r.scope)
            } catch(err) {
              log.error("Failed to parse policy scope string:", r.scope, {})
              r.scope = []
            }
          }
          return this.jsonToPolicy(r)
        }).filter((r) => r != null)

        // recent first
        rr.sort((a, b) => {
          return b.timestamp > a.timestamp
        })

        callback(null, rr)

      });
    }

    loadRecentPolicys(duration, callback) {
      if(typeof(duration) == 'function') {
        callback = duration;
        duration = 86400;
      }

      callback = callback || function() {}

      let scoreMax = new Date() / 1000 + 1;
      let scoreMin = scoreMax - duration;
      rclient.zrevrangebyscore(policyActiveKey, scoreMax, scoreMin, (err, policyIDs) => {
        if(err) {
          log.error("Failed to load active policys: " + err);
          callback(err);
          return;
        }

        this.idsToPolicys(policyIDs, callback);
      });
    }

  numberOfPolicys(callback) {
    callback = callback || function() {}

    rclient.zcount(policyActiveKey, "-inf", "+inf", (err, result) => {
      if(err) {
        callback(err);
        return;
      }

      // TODO: support more than 20 in the future
      callback(null, result > 20 ? 20 : result);
    });
  }

  loadActivePolicysAsync(number) {
    number = number || 1000 // default 1000
    return new Promise((resolve, reject) => {
      this.loadActivePolicys(number, (err, policies) => {
        if(err) {
          reject(err)
        } else {
          resolve(policies)
        }
      })
    })
  }
  
  // FIXME: top 1000 only by default
  // we may need to limit number of policy rules created by user
  loadActivePolicys(number, options, callback) {

    if(typeof(number) == 'function') {
      callback = number;
      number = 1000; // by default load last 1000 policy rules, for self-protection
      options = {}
    }

    if(typeof options === 'function') {
      callback = options
      options = {}
    }

    callback = callback || function() {}

    rclient.zrevrange(policyActiveKey, 0, number -1 , (err, results) => {
      if(err) {
        log.error("Failed to load active policys: " + err);
        callback(err);
        return;
      }

      this.idsToPolicys(results, (err, policyRules) => {
        if(options.includingDisabled) {
          callback(err, policyRules)
        } else {
          callback(err, policyRules.filter((r) => r.disabled != "1")) // remove all disabled one
        }
      });
    });
  }

  // cleanup before use
  cleanupPolicyData() {
    return async(() => {
      await (domainBlock.removeAllDomainIPMapping())
    })() 
  }

  enforceAllPolicies() {
    return new Promise((resolve, reject) => {
      this.loadActivePolicys((err, rules) => {
        
        return async(() => {
          rules.forEach((rule) => {
            try {
              if(this.queue) {
                const job = this.queue.createJob({
                  policy: rule,
                  action: "enforce",
                  booting: true
                })
                job.timeout(60000).save(function() {})
              }
            } catch(err) {
              log.error(`Failed to enforce policy ${rule.pid}: ${err}`)
            }            
          })
          log.info("All policy rules are enforced")
        })()
      });
    });
  }


  parseDevicePortRule(target) {
    return async(() => {
      let matches = target.match(/(.*):(\d+):(tcp|udp)/)
      if(matches) {
        let mac = matches[1]
        let host = await (ht.getMACEntry(mac))
        if(host) {
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

    })()
  }
    
  isFirewallaCloud(policy) {
    const target = policy.target

    return sysManager.isMyServer(target) ||
           sysManager.myIp() === target ||
           sysManager.myIp2() === target ||
           target === "firewalla.encipher.com" ||
           target === "firewalla.com" ||
           minimatch(target, "*.firewalla.com")
  }

  enforce(policy) {
    if(policy.disabled == 1) {
      return // ignore disabled policy rules
    }
    
    // auto unenforce if expire time is set
    if(policy.expire) {
      if(policy.willExpireSoon())  {
        // skip enforce as it's already expired or expiring
        return async(() => {
          await (delay(policy.getExpireDiffFromNow() * 1000 ))
          await (this._disablePolicy(policy))
          if(policy.autoDeleteWhenExpires && policy.autoDeleteWhenExpires == "1") {
            await (this.deletePolicy(policy.pid))
          }
        })()
        log.info(`Skip policy ${policy.pid} as it's already expired or expiring`)
      } else {
        return async(() => {
          await (this._enforce(policy))
          log.info(`Will auto revoke policy ${policy.pid} in ${Math.floor(policy.getExpireDiffFromNow())} seconds`)
          const pid = policy.pid          
          const policyTimer = setTimeout(() => {
            async(() => {
              log.info(`About to revoke policy ${pid} `)
              // make sure policy is still enabled before disabling it
              const policy = await (this.getPolicy(pid))

              // do not do anything if policy doesn't exist any more or it's disabled already
              if(!policy || policy.isDisabled()) {
                return
              }

              log.info(`Revoke policy ${policy.pid}, since it's expired`)
              await (this.unenforce(policy))
              await (this._disablePolicy(policy))
              if(policy.autoDeleteWhenExpires && policy.autoDeleteWhenExpires == "1") {
                await (this.deletePolicy(pid))
              }
            })()
          }, policy.getExpireDiffFromNow() * 1000) // in milli seconds, will be set to 1 if it is a negative number

          this.invalidateExpireTimer(policy) // remove old one if exists
          this.enabledTimers[pid] = policyTimer
        })()
      }
    } else if (policy.cronTime) {
      // this is a reoccuring policy, use scheduler to manage it
      return scheduler.registerPolicy(policy)
    } else {
      return this._enforce(policy) // regular enforce
    }
  }

  // this is the real execution of enable and disable policy
  _enablePolicy(policy) {
    return async(() => {
      const now = new Date() / 1000
      await (this.updatePolicyAsync({
        pid: policy.pid,
        disabled: 0,
        activatedTime: now
      }))
      policy.disabled = 0
      policy.activatedTime = now
      log.info(`Policy ${policy.pid} is enabled`)
      return policy
    })()
  }

  _disablePolicy(policy) {
    return async(() => {
      await (this.updatePolicyAsync({
        pid: policy.pid,
        disabled: 1 // flag to indicate that this policy is revoked successfully.
      }))
      policy.disabled = 1
      log.info(`Policy ${policy.pid} is disabled`)
      return policy
    })()
  }

  _refreshActivatedTime(policy) {
    return async(() => {
      const now = new Date() / 1000
      let activatedTime = now;
      // retain previous activated time, this happens if policy is not deactivated normally, e.g., reboot, restart
      if (policy.activatedTime) {
        activatedTime = policy.activatedTime;
      }
      await (this.updatePolicyAsync({
        pid: policy.pid,
        activatedTime: activatedTime
      }))
      policy.activatedTime = activatedTime
      return policy
    })()
  }

  async _removeActivatedTime(policy) {
    await (this.updatePolicyAsync({
      pid: policy.pid,
      activatedTime: ""
    }))

    delete policy.activatedTime;
    return policy;
  }

  _enforce(policy) {
    log.debug("Enforce policy: ", policy, {});
    log.info("Enforce policy: ", policy.pid, policy.type, policy.target, {});

    let type = policy["i.type"] || policy["type"]; //backward compatibility

    if(policy.scope) {
      return this._advancedEnforce(policy)
    }

    return async(() => {
      await (this._refreshActivatedTime(policy))

      if(this.isFirewallaCloud(policy)) {
        return Promise.reject(new Error("Firewalla cloud can't be blocked."))
      }
  
      switch(type) {
      case "ip":
        return Block.block(policy.target);
        break;
      case "mac":
        return Block.blockMac(policy.target);
        break;
      case "domain":
      case "dns":    
        return domainBlock.blockDomain(policy.target, {exactMatch: policy.domainExactMatch})
        break;
      case "devicePort":
        return async(() => {
          let data = await (this.parseDevicePortRule(policy.target))
          if(data) {
            Block.blockPublicPort(data.ip, data.port, data.protocol)
          }
        })()
        break;
      case "category":
        return categoryBlock.blockCategory(policy.target)
      case "timer":
        // just send notification, purely testing purpose only
      default:
        return Promise.reject("Unsupported policy");
      }
    })()    
  }

  _advancedEnforce(policy) {
    return async(() => {
      log.info("Advance enforce policy: ", policy.pid, policy.type, policy.target, policy.scope, {})

      const type = policy["i.type"] || policy["type"]; //backward compatibility

      if(this.isFirewallaCloud(policy)) {
        return Promise.reject(new Error("Firewalla cloud can't be blocked."))
      }

      let scope = policy.scope
      if(typeof scope === 'string') {
        try {
          scope = JSON.parse(scope)
        } catch(err) {
          log.error("Failed to parse scope:", err, {})
          return Promise.reject(new Error(`Failed to parse scope: ${err}`))
        }        
      }

      switch(type) {
      case "ip":
        if(scope) {
          return Block.advancedBlock(policy.pid, scope, [policy.target])
        } else {
          return Block.block(policy.target)
        }
        break;
      case "mac":
        return Block.blockMac(policy.target);
        break;
      case "domain":
      case "dns":    
        return async(() => {
          if(scope) {
            await (Block.advancedBlock(policy.pid, scope, []))
            return domainBlock.blockDomain(policy.target, {
              exactMatch: policy.domainExactMatch, 
              blockSet: Block.getDstSet(policy.pid),
              no_dnsmasq_entry: true
            })
          } else {
            return domainBlock.blockDomain(policy.target, {exactMatch: policy.domainExactMatch})
          }
        })()        
        
        break;
      case "devicePort":
        return async(() => {
          let data = await (this.parseDevicePortRule(policy.target))
          if(data) {
            Block.blockPublicPort(data.ip, data.port, data.protocol)
          }
        })()
        break;
      case "category":
        return async(() => {
          if(scope) {
            await (Block.advancedBlock(policy.pid, scope, []))
            return categoryBlock.blockCategory(policy.target, {
              blockSet: Block.getDstSet(policy.pid),
              macSet: Block.getMacSet(policy.pid),
              no_dnsmasq_entry: true
            })
          } else {
            return categoryBlock.blockCategory(policy.target)
          }
        })()
        break;

      default:
        return Promise.reject("Unsupported policy");
      }

    })()
  }

  invalidateExpireTimer(policy) {
    const pid = policy.pid
    if(this.enabledTimers[pid]) {
      log.info("Invalidate expire timer for policy", pid, {})
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
    log.info("Unenforce policy: ", policy.pid, policy.type, policy.target, {})

    await this._removeActivatedTime(policy)

    if(policy.scope) {
      return this._advancedUnenforce(policy)
    }

    let type = policy["i.type"] || policy["type"]; //backward compatibility
    switch(type) {
    case "ip":
      return Block.unblock(policy.target);
      break;
    case "mac":
      return Block.unblockMac(policy.target);
      break;
    case "domain":
    case "dns":
      return domainBlock.unblockDomain(policy.target, {exactMatch: policy.domainExactMatch})
    case "devicePort":
      return async(() => {
      let data = await (this.parseDevicePortRule(policy.target))
      if(data) {
        Block.unblockPublicPort(data.ip, data.port, data.protocol)
      }
      })()
      break;
    case "category":
      return categoryBlock.unblockCategory(policy.target)
      break
    default:
      return Promise.reject("Unsupported policy");
    }
  }

  _advancedUnenforce(policy) {
    return async(() => {
      log.info("Advance unenforce policy: ", policy.pid, policy.type, policy.target, policy.scope, {})

      const type = policy["i.type"] || policy["type"]; //backward compatibility

      let scope = policy.scope
      if(typeof scope === 'string') {
        try {
          scope = JSON.parse(scope)
        } catch(err) {
          log.error("Failed to parse scope:", err, {})
          return Promise.reject(new Error(`Failed to parse scope: ${err}`))
        }        
      }

      switch(type) {
      case "ip":
        if(scope) {
          return Block.advancedUnblock(policy.pid, scope, [policy.target])
        } else {
          return Block.unblock(policy.target)
        }
        break;
      case "mac":
        return Block.unblockMac(policy.target)
        break;
      case "domain":
      case "dns":    
        return async(() => {
          if(scope) {
            await (Block.advancedUnblock(policy.pid, scope, []))
            return domainBlock.unblockDomain(policy.target, {
              exactMatch: policy.domainExactMatch, 
              blockSet: Block.getDstSet(policy.pid),
              no_dnsmasq_entry: true
            })
          } else {
            return domainBlock.unblockDomain(policy.target, {exactMatch: policy.domainExactMatch})
          }
        })()        
        
        break;
      case "devicePort":
        return async(() => {
          let data = await (this.parseDevicePortRule(policy.target))
          if(data) {
            Block.unblockPublicPort(data.ip, data.port, data.protocol)
          }
        })()
        break;
      case "category":
        return async(() => {
          if(scope) {
            await (categoryBlock.unblockCategory(policy.target, {
              blockSet: Block.getDstSet(policy.pid),
              macSet: Block.getMacSet(policy.pid),
              ignoreUnapplyBlock: true,
              no_dnsmasq_entry: true
            }))
            return Block.advancedUnblock(policy.pid, scope, [])
          } else {
            return categoryBlock.unblockCategory(policy.target)
          }
        })()
      
      default:
        return Promise.reject("Unsupported policy");
      }

    })()
  }

  match(alarm, callback) {
    this.loadActivePolicys((err, policies) => {
      if(err) {
        log.error("Failed to load active policy rules")
        callback(err)
        return
      }

      const matchedPolicies = policies.filter((policy) => {
        return policy.match(alarm)
      })
      
      if(matchedPolicies.length > 0) {
        callback(null, true)
      } else {
        callback(null, false)  
      }
    })
  }


  // utility functions
  findPolicy(target, type) {
    return async(() => {
      let rules = await (this.loadActivePolicysAsync())

      for (const index in rules) {
        const rule = rules[index]
        if(rule.target === target && type === rule.type) {
          return rule 
        }
      }

      return null
    })()
  }
}

module.exports = PolicyManager2;
