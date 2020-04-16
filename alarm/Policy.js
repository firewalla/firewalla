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

const log = require('../net2/logger.js')(__filename);

const util = require('util');
const minimatch = require("minimatch");
const cronParser = require('cron-parser');

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
        } catch (e) {
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

    if (raw.tag) {
      if (_.isString(raw.tag)) {
        try {
          this.tag = JSON.parse(raw.tag)
        } catch (e) {
          log.error("Failed to parse policy tag string:", raw.tag, e)
        }
      } else if (_.isArray(raw.tag)) {
        this.tag = Array.from(raw.tag); // clone array to avoide side effects
      } else {
        log.error("Unsupported tag", raw.tag)
      }

      if (!_.isArray(this.tag) || _.isEmpty(this.tag))
        delete this.tag;
    }
    this.upnp = false;
    if (raw.upnp)
      this.upnp = JSON.parse(raw.upnp);

    if (raw.expire === "") {
      delete this.expire;
    } else if (raw.expire && _.isString(raw.expire)) {
      try {
        this.expire = parseInt(raw.expire)
      } catch (e) {
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

    if (this.target && this.type) {
      switch (this.type) {
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
    if (!policy) {
      return false
    }
    if (!policy instanceof Policy)
      policy = new Policy(policy) // leverage the constructor for compatibilities conversion

    if (
      this.type === policy.type &&
      this.target === policy.target &&
      this.expire === policy.expire &&
      this.cronTime === policy.cronTime &&
      this.remotePort === policy.remotePort &&
      this.localPort === policy.localPort &&
      this.protocol === policy.protocol &&
      this.direction === policy.direction &&
      this.action === policy.action &&
      this.upnp === policy.upnp
    ) {
      return arraysEqual(this.scope, policy.scope) && arraysEqual(this.tag, policy.tag);
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
  inSchedule(alarmTimestamp) {
    const cronTime = this.cronTime;
    const duration = parseFloat(this.duration); // in seconds
    const interval = cronParser.parseExpression(cronTime);
    const lastDate = interval.prev().getTime() / 1000;
    log.info(`lastDate: ${lastDate}, duration: ${duration}, alarmTimestamp:${alarmTimestamp}`);

    if (alarmTimestamp > lastDate && alarmTimestamp < lastDate + duration) {
      return true
    } else {
      return false
    }
  }

  match(alarm) {

    if (this.isExpired()) {
      return false // always return unmatched if policy is already expired
    }
    if (this.cronTime && this.duration && !this.inSchedule(alarm.alarmTimestamp)) {
      return false;
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

    if (
      this.tag &&
      _.isArray(this.tag) &&
      !_.isEmpty(this.tag) &&
      alarm['p.intf.id'] &&
      !this.tag.includes(Policy.INTF_PREFIX + alarm['p.intf.id'])
    ) {
      return false; // tag not match
    }

    if (
      this.tag &&
      _.isArray(this.tag) &&
      !_.isEmpty(this.tag) &&
      _.has(alarm, 'p.tag.ids') &&
      !_.isEmpty(alarm['p.tag.ids'])
    ) {
      let found = false;
      for (let index = 0; index < alarm['p.tag.ids'].length; index++) {
        const tag = alarm['p.tag.ids'][index];
        if (this.tag.includes(Policy.TAG_PREFIX + tag)) {
          found = true;
        }
      }

      if (!found) {
        return false;
      }
    }

    // for each policy type
    switch (this.type) {
      case "ip":
        if (alarm['p.dest.ip']) {
          return this.target === alarm['p.dest.ip']
        } else {
          return false
        }
        break

      case "dns":
      case "domain":
        if (alarm['p.dest.name']) {
          return minimatch(alarm['p.dest.name'], `*.${this.target}`) ||
            alarm['p.dest.name'] === this.target
        } else {
          return false
        }
        break

      case "mac":
        if (alarm['p.device.mac']) {
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
    if (p.scope) {
      if (p.scope.length > 0)
        p.scope = JSON.stringify(p.scope);
      else
        delete p.scope;
    }

    if (p.tag) {
      if (p.tag.length > 0)
        p.tag = JSON.stringify(p.tag);
      else
        delete p.tag;
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

Policy.INTF_PREFIX = "intf:";
Policy.TAG_PREFIX = "tag:";

module.exports = Policy
