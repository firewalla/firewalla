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

let log = require('../net2/logger.js')(__filename, 'info');

let redis = require('redis');
let rclient = redis.createClient();

let flat = require('flat');

let audit = require('../util/audit.js');
let util = require('util');
let Bone = require('../lib/Bone.js');

let async = require('asyncawait/async')
let await = require('asyncawait/await')

const Promise = require('bluebird');

const minimatch = require('minimatch')

const SysManager = require('../net2/SysManager.js')
const sysManager = new SysManager('info');

let instance = null;

let policyActiveKey = "policy_active";

let policyIDKey = "policy:id";
let policyPrefix = "policy:";
let initID = 1;

let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ();

let sem = require('../sensor/SensorEventManager.js').getInstance();

let extend = require('util')._extend;

let Block = require('../control/Block.js');

let Policy = require('./Policy.js');

const HostTool = require('../net2/HostTool.js')
const ht = new HostTool()




class PolicyManager2 {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  registerPolicyEnforcementListener() {
    log.info("register policy enforcement listener")
    sem.on("PolicyEnforcement", (event) => {
      if (event && event.policy) {
        log.info("got policy enforcement event:" + event.action + ":" + event.policy.pid)
        async(()=>{
          if (event.action && event.action == 'enforce') {
              try {
                await(this.enforce(event.policy))
              } catch (err) {
                log.error("enforce policy failed:" + err)
              }
          } else if (event && event.action == 'unenforce') {
              try {
                await(this.unenforce(event.policy))
              } catch (err) {
                log.error("failed to unenforce policy:" + err)
              }
              
              try {
                await(this.deletePolicy(event.policy.pid))
              } catch (err) {
                log.error("failed to delete policy:" + err)
              }
          } else {
            log.error("unrecoganized policy enforcement action:" + event.action)
          }
        })()
      }
    })
  }

  tryPolicyEnforcement(policy, action) {
    if (policy) {
      action = action || 'enforce'
      log.info("try policy enforcement:" + action + ":" + policy.pid)

      sem.emitEvent({
        type: 'PolicyEnforcement',
        toProcess: 'FireMain',//make sure firemain process handle enforce policy event
        message: 'Policy Enforcement:' + action,
        action : action, //'enforce', 'unenforce'
        policy : policy
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

      rclient.hmset(policyKey, flat.flatten(policy), (err) => {
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
          callback(null, policy.pid)
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
        // let policies = await(this.getSamePolicies(policy))
        // if (policies && policies.length > 0) {
        //   log.info("policy with type:" + policy.type + ",target:" + policy.target + " already existed")
        //   callback(new Error("policy existed"))
        // } else {
        this.savePolicy(policy, callback);
//        }
      } catch (err) {
        log.error("failed to save policy:" + err)
        callback(err)
      }
    })()
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
        pm2.loadActivePolicys(200, (err, policies)=>{
          if (err) {
            log.error("failed to load active policies:" + err)
            reject(err)
          } else {
            if (policies) {
              let type = policy["i.type"] || policy["type"]
              let target = policy["i.target"] || policy["target"]
              resolve(policies.filter(p => {
                let ptype = p["i.type"] || p["type"]
                let ptarget = p["i.target"] || p["target"]
                return type === ptype && target === ptarget
              }))
            } else {
              resolve([])
            }
          }    
        })
      })
    })();
  }

  disableAndDeletePolicy(policyID) {
    let p = this.getPolicy(policyID);

    if(!p) {
      return Promise.resolve()
    }
    
    return p.then((policy) => {
      this.tryPolicyEnforcement(policy, "unenforce")

      Bone.submitIntelFeedback('unblock', policy, 'policy');
      return Promise.resolve()
    }).catch((err) => Promise.reject(err));
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
        
        let rr = results.map((r) => this.jsonToPolicy(r)).filter((r) => r != null)

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

  // FIXME: top 1000 only by default
  // we may need to limit number of policy rules created by user
  loadActivePolicys(number, callback) {

    if(typeof(number) == 'function') {
      callback = number;
      number = 1000; // by default load last 1000 policy rules, for self-protection
    }

    callback = callback || function() {}

    rclient.zrevrange(policyActiveKey, 0, number -1 , (err, results) => {
      if(err) {
        log.error("Failed to load active policys: " + err);
        callback(err);
        return;
      }

      this.idsToPolicys(results, callback);
    });
  }

  enforceAllPolicies() {
    return new Promise((resolve, reject) => {
      this.loadActivePolicys((err, rules) => {

        let enforces = rules.map((rule) => this.enforce(rule));

        return Promise.all(enforces);
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
           target === "firewalla.encipher.com" ||
           target === "firewalla.com" ||
           minimatch(target, "*.firewalla.com")
  }

  enforce(policy) {
    log.info("Enforce policy: ", policy, {});

    let type = policy["i.type"] || policy["type"]; //backward compatibility

    if(this.isFirewallaCloud(policy)) {
      return Promise.reject(new Error("Firewalla cloud can't be blocked."))
    }

    switch(type) {
    case "ip":
      return Block.block(policy.target);
      break;
    case "mac":
      let blockMacAsync = Promise.promisify(Block.blockMac);
      return blockMacAsync(policy.target);
      break;
    case "domain":
    case "dns":    
      return dnsmasq.addPolicyFilterEntry(policy.target)
        .then(() => {
          sem.emitEvent({
            type: 'ReloadDNSRule',
            message: 'DNSMASQ filter rule is updated',
            toProcess: 'FireMain'
          });
        });
      break;
    case "devicePort":
      return async(() => {
        let data = await (this.parseDevicePortRule(policy.target))
        if(data) {
          Block.blockPublicPort(data.ip, data.port, data.protocol)
        }
      })()
      break;
    default:
      return Promise.reject("Unsupported policy");
    }
  }

  unenforce(policy) {
    log.info("Unenforce policy: ", policy, {});

    let type = policy["i.type"] || policy["type"]; //backward compatibility
    switch(type) {
    case "ip":
      return Block.unblock(policy.target);
      break;
    case "mac":
      let unblockMacAsync = Promise.promisify(Block.unblockMac);
      return unblockMacAsync(policy.target);
      break;
    case "domain":
    case "dns":
      return dnsmasq.removePolicyFilterEntry(policy.target)
        .then(() => {
          sem.emitEvent({
            type: 'ReloadDNSRule',
            message: 'DNSMASQ filter rule is updated',
            toProcess: 'FireMain'
          });
      });
    case "devicePort":
       return async(() => {
        let data = await (this.parseDevicePortRule(policy.target))
        if(data) {
          Block.unblockPublicPort(data.ip, data.port, data.protocol)
        }
       })()
      break;
    default:
      return Promise.reject("Unsupported policy");
    }
  }

  match(alarm, callback) {
    this.loadActivePolicys((err, policies) => {
      if(err) {
        log.error("Failed to load active policy rules")
        callback(err)
        return
      }

      policies.forEach((policy) => {
        if(policy.match(alarm)) {
          callback(null, true)
          return
        }
      })

      callback(null, false)
    })
  }
}

module.exports = PolicyManager2;
