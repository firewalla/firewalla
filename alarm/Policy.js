/*    Copyright 2016 Firewalla INC
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

const util = require('util');
const minimatch = require("minimatch");

const _ = require('lodash');
const flat = require('flat');

const POLICY_MIN_EXPIRE_TIME = 60 // if policy is going to expire in 60 seconds, don't bother to enforce it.

function arraysEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length != b.length) return false;

  // If you don't care about the order of the elements inside
  // the array, you should sort both arrays here.

  for (var i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

class Policy {
  constructor(raw) {
    if (!raw) throw new Error("Empty policy payload");
    if (!raw.type && !raw['i.type']) throw new Error("Invalid policy payload");

    Object.assign(this, raw);

    if (raw.scope) {
      if (_.isString(raw.scope)) {
        try {
          this.scope = JSON.parse(raw.scope)
        } catch(e) {
          log.error("Failed to parse policy scope string:", raw.scope, e)
        }
      } else if (_.isArray(raw.scope)) {
        this.scope = raw.scope.slice(0) // clone array to avoide side effects
      } else {
        log.error("Unsupported scope", raw.scope)
      }

      if (!_.isArray(this.scope) || _.isEmpty(this.scope))
        delete this.scope;
    }

    if (raw.expire === "") {
      delete this.expire;
    } else if (raw.expire && _.isString(raw.expire)) {
      try {
        this.expire = parseInt(raw.expire)
      } catch(e) {
        log.error("Failed to parse policy expire time:", raw.expire, e);
        delete this.expire;
      }
    }

    if (raw.cronTime === "") {
      delete this.cronTime;
    }

    // backward compatibilities
    if (this['i.type']) {
      this.type = this['i.type'];
      delete this['i.type'];
    }
    if (this['i.target']) {
      this.target = this['i.target'];
      delete this['i.target'];
    }

    if(this.target && this.type) {
      switch(this.type) {
        case "mac":
          this.target = this.target.toUpperCase(); // always upper case for mac address
          break;
        case "dns":
        case "domain":
          this.target = this.target.toLowerCase(); // always lower case for domain block
          break;
        default:
        // do nothing;
      }
    }

    this.timestamp = this.timestamp || new Date() / 1000;

  }

  isEqualToPolicy(policy) {
    if(!policy) {
      return false
    }
    if (!policy instanceof Policy)
      policy = new Policy(policy) // leverage the constructor for compatibilities conversion
    
    if (
      this.type === policy.type &&
      this.target === policy.target &&
      this.expire === policy.expire &&
      this.cronTime === policy.cronTime
    ) {
      return arraysEqual(this.scope, policy.scope)
    } else {
      return false
    }
  }

  isExpired() {
    const expire = this.expire || NaN
    const activatedTime = this.activatedTime || this.timestamp
    return parseFloat(activatedTime) + parseFloat(expire) < new Date() / 1000
  }

  willExpireSoon() {
    const expire = this.expire || NaN
    const activatedTime = this.activatedTime || this.timestamp
    return parseFloat(activatedTime) + parseFloat(expire) < new Date() / 1000 + POLICY_MIN_EXPIRE_TIME
  }

  getWhenExpired() {
    const expire = this.expire || NaN
    const activatedTime = this.activatedTime || this.timestamp
    return parseFloat(activatedTime) + parseFloat(expire)
  }

  getExpireDiffFromNow() {
    return this.getWhenExpired() - new Date() / 1000
  }

  isDisabled() {
    return this.disabled && this.disabled == '1'
  }

  match(alarm) {

    if(this.isExpired()) {
      return false // always return unmatched if policy is already expired
    }

    if (
      this.scope &&
      _.isArray(this.scope) &&
      !_.isEmpty(this.scope) &&
      alarm['p.device.mac'] &&
      !this.scope.includes(alarm['p.device.mac'])
    ) {
      return false; // scope not match
    }

    // for each policy type
    switch(this.type) {
    case "ip":
      if(alarm['p.dest.ip']) {
        return this.target === alarm['p.dest.ip']        
      } else {
        return false
      }
      break

    case "dns":
    case "domain":
      if(alarm['p.dest.name']) {
        return minimatch(alarm['p.dest.name'], `*.${this.target}`) ||
          alarm['p.dest.name'] === this.target
      } else {
        return false
      }
      break

    case "mac":
      if(alarm['p.device.mac']) {
        return alarm['p.device.mac'] === this.target
      } else {
        return false
      }
      break

    case "category":
      if (alarm['p.dest.category']) {
        return alarm['p.dest.category'] === this.target;
      } else {
        return false;
      }
      break

    case "devicePort":
      if (!alarm['p.device.mac']) return false;

      if (alarm["p.device.port"] &&
          alarm["p.protocol"]
      ) {
        let alarmTarget = util.format("%s:%s:%s",
          alarm["p.device.mac"],
          alarm["p.device.port"],
          alarm["p.protocol"]
        )
        return alarmTarget === this.target;
      }

      if (alarm["p.upnp.private.port"] &&
          alarm["p.upnp.protocol"]
      ) {
        let alarmTarget = util.format("%s:%s:%s",
          alarm["p.device.mac"],
          alarm["p.upnp.private.port"],
          alarm["p.upnp.protocol"]
        )
        return alarmTarget === this.target;
      } 

      return false;
      break
    default:
      return false
      break
    }
  }

  // return a new object ready for redis writing
  redisfy() {
    let p = JSON.parse(JSON.stringify(this))

    // convert array to string so that redis can store it as value
    if(p.scope) {
      if (p.scope.length > 0)
        p.scope = JSON.stringify(p.scope);
      else
        delete p.scope;
    }

    if (p.expire === "") {
      delete p.expire;
    }

    if (p.cronTime === "") {
      delete p.cronTime;
    }

    return flat.flatten(p);
  }
}

module.exports = Policy
