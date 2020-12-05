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
const iptool = require('ip');
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
    if (raw.type == 'internet') throw new Error(`Invalid policy type ${raw.type}`);

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

    if (raw.priority)
      this.priority = Number(raw.priority);

    if (raw.transferredBytes)
      this.transferredBytes = Number(raw.transferredBytes);

    if (raw.transferredPackets)
      this.transferredPackets = Number(raw.transferredPackets);

    if (raw.avgPacketBytes)
      this.avgPacketBytes = Number(raw.avgPacketBytes);

    this.dnsmasq_only = false;
    if (raw.dnsmasq_only)
      this.dnsmasq_only = JSON.parse(raw.dnsmasq_only);

    if (!raw.direction)
      this.direction = "bidirection";
    
    if (!raw.action)
      this.action = "block";

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
    if (!(policy instanceof Policy))
      policy = new Policy(policy) // leverage the constructor for compatibilities conversion

    if (this.related_screen_time_pid === policy.related_screen_time_pid &&
      this.target === policy.target &&
      this.type === policy.type &&
      arraysEqual(this.scope, policy.scope) &&
      arraysEqual(this.tag, policy.tag)
    ) {
      return true;
    }
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
      this.upnp === policy.upnp &&
      this.dnsmasq_only === policy.dnsmasq_only &&
      this.trafficDirection === policy.trafficDirection &&
      this.transferredBytes === policy.transferredBytes &&
      this.transferredPackets === policy.transferredPackets &&
      this.avgPacketBytes === policy.avgPacketBytes
    ) {
      // ignore scope if type is mac
      return (this.type == 'mac' || arraysEqual(this.scope, policy.scope)) && arraysEqual(this.tag, policy.tag);
    } else {
      return false
    }
  }
  getIdleInfo() {
    if (this.idleTs) {
      const idleTs = Number(this.idleTs);
      const now = new Date() / 1000;
      const idleTsFromNow = idleTs - now;
      const idleExpireSoon = idleTs < (now + POLICY_MIN_EXPIRE_TIME);
      return {
        idleTsFromNow, idleExpireSoon
      }
    } else {
      return null;
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
    const sysManager = require('../net2/SysManager.js');
    const cronTime = this.cronTime;
    const duration = parseFloat(this.duration); // in seconds
    const interval = cronParser.parseExpression(cronTime, {tz: sysManager.getTimezone()});
    const lastDate = interval.prev().getTime() / 1000;
    log.info(`lastDate: ${lastDate}, duration: ${duration}, alarmTimestamp:${alarmTimestamp}`);

    if (alarmTimestamp > lastDate && alarmTimestamp < lastDate + duration) {
      return true
    } else {
      return false
    }
  }

  match(alarm) {

    if (!alarm.needPolicyMatch()) {
      return false;
    }

    if (this.action == 'allow') {
      return false;
    }

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

    if (this.localPort && alarm['p.device.port']) {
      const notInRange = this.portInRange(this.localPort, alarm['p.device.port']);
      if (!notInRange) return false;
    }

    if (this.remotePort && alarm['p.dest.port']) {
      const notInRange = this.portInRange(this.remotePort, alarm['p.dest.port']);
      if (!notInRange) return false;
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
      case "net":
        if (alarm['p.dest.ip']) {
          return iptool.cidrSubnet(this.target).contains(alarm['p.dest.ip'])
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
      case "remotePort":
        if (alarm['p.dest.port']) {
          return this.portInRange(this.target, alarm['p.dest.port'])
        } else {
          return false;
        }
        break;
      case 'country':
        if (alarm['p.dest.country']) {
          return alarm['p.dest.country'] == this.target;
        } else {
          return false;
        }
        break;
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

  portInRange(portRange, port) {
    // portRange 555 || 555-666
    // port '600' || '[52492,61734]'
    portRange = (portRange || '').split('-');
    if (portRange.length == 1) portRange.push(portRange[0]); // [555,555]
    if (_.isString(port)) {
      try {
        port = JSON.parse(port);
      } catch (e) {
        port = (port || 0) * 1;
      }
    }
    if (_.isArray(port)) {
      let allInRange = true;
      for (const p of port) {
        allInRange = allInRange && portRange[0] * 1 <= p && p <= portRange[1] * 1;
        if (!allInRange) return false;
      }
    } else {
      return portRange[0] * 1 <= port && port <= portRange[1] * 1;
    }
  }
}

Policy.INTF_PREFIX = "intf:";
Policy.TAG_PREFIX = "tag:";

module.exports = Policy
