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

let Promise = require('bluebird');

let instance = null;

let policyActiveKey = "policy_active";

let policyIDKey = "policy:id";
let policyPrefix = "policy:";
let initID = 1;

let extend = require('util')._extend;

let Block = require('../control/Block.js');

let Policy = require('./Policy.js');

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
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
  
  savePolicy(policy, callback) {
    callback = callback || function() {}

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      policy.pid = id;

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

          this.enforce(policy)
            .then(() => {
              callback(null, policy.pid);
            }).catch((err) => callback(err));
        });
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
          reject(new Error("policy not exists"));
          return;
        }

        resolve(results[0]);
      });
    });
  }
  
  disableAndDeletePolicy(policyID) {
    let p = this.getPolicy(policyID);
    
    return p.then((policy) => {
      this.unenforce(policy)
        .then(() => {
          return this.deletePolicy(policyID);
        })
        .catch((err) => Promise.reject(err));
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
        
        callback(null, results.map((r) => this.jsonToPolicy(r)).filter((r) => r != null));
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
      number = 200;
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

  enforce(policy) {
    switch(policy.type) {
    case "ip":
      return Block.block(policy.target);
      break;
    case "mac":
      let blockMacAsync = Promise.promisify(Block.blockMac);
      return blockMacAsync(policy.target);
      break;
    case "ip_port":
      return Block.blockPublicPort(policy.target, policy.target_port, policy.target_protocol);
      break;
    default:
      return Promise.reject("Unsupported policy");
    }    
  }

  unenforce(policy) {
    switch(policy.type) {
    case "ip":
      return Block.unblock(policy.target);
      break;
    case "mac":
      let unblockMacAsync = Promise.promisify(Block.unblockMac);
      return unblockMacAsync(policy.target);
      break;
    case "ip_port":
      return Block.unblockPublicPort(policy.target, policy.target_port, policy.target_protocol);
      break;
    default:
      return Promise.reject("Unsupported policy");
    }
  }

}

