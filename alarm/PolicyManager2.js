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

let Promise = require('bluebird');

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

        if (event.action && event.action == 'enforce') {
          this.enforce(event.policy)
        } else if (event && event.action == 'unenforce') {
          this.unenforce(event.policy).then(() => {
            this.deletePolicy(event.policy.pid);
          })
        } else {
          log.error("unrecoganized policy enforcement action:" + event.action)
        }
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

        Bone.submitUserIntel('block', policy);
      });
    });
  }

  checkAndSave(policy, callback) {
    callback = callback || function() {}

    this.savePolicy(policy, callback);
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

  disableAndDeletePolicy(policyID) {
    let p = this.getPolicy(policyID);

    if(!p) {
      return Promise.resolve()
    }
    
    return p.then((policy) => {
      this.tryPolicyEnforcement(policy, "unenforce")

      Bone.submitUserIntel('unblock', policy);
      return Promise.resolve()
    }).catch((err) => Promise.reject(err));
  }

  deletePolicy(policyID) {
    log.info("Trying to delete policy " + policyID);
    return this.policyExists(policyID)
      .then((exists) => {
        if(!exists) {
          log.error("policy " + policyID + " doesn't exists");
          return Promise.reject("policy " + policyID + " doesn't exists");
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

  // FIXME: top 200 only by default
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

  enforce(policy) {
    log.info("Enforce policy: ", policy, {});

    let type = policy["i.type"] || policy["type"]; //backward compatibility

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
    case "ip_port":
      return Block.blockPublicPort(policy.target, policy.target_port, policy.target_protocol);
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
    case "ip_port":
      return Block.unblockPublicPort(policy.target, policy.target_port, policy.target_protocol);
      break;
    default:
      return Promise.reject("Unsupported policy");
    }
  }

}

module.exports = PolicyManager2;
