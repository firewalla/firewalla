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

const extend = require('util')._extend

const minimatch = require("minimatch")

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

module.exports = class {
  constructor(info) {
    this.timestamp = new Date() / 1000;
    if(info)
      extend(this, info);
  }

  isEqualToPolicy(policy) {
    if(!policy) {
      return false
    }
    
    const thisType = this["i.type"] || this["type"]
    const thatType = policy["i.type"] || policy["type"]
    const thisTarget = this["i.target"] || this["target"]
    const thatTarget = policy["i.target"] || policy["target"]

    if(thisType === thatType && thisTarget === thatTarget && this.expire === policy.expire && this.cronTime === policy.cronTime) {
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
    case "devicePort":
      return false // no alarm supports on devicePort yet
      break
    default:
      return false
      break
    }
  }
}

