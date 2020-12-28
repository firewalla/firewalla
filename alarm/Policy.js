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

const util = require('util');
const minimatch = require("minimatch");
const cronParser = require('cron-parser');
const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()
const Constants = require('../net2/Constants.js');

const _ = require('lodash');
const flat = require('flat');
const iptool = require('ip');
const POLICY_MIN_EXPIRE_TIME = 60 // if policy is going to expire in 60 seconds, don't bother to enforce it.

function arraysEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (!a && !_.isNil(a) || !b && !_.isNil(b)) return false // exclude false, NaN
  if (_.isEmpty(a) && _.isEmpty(b)) return true;  // [], undefined
  if (!Array.isArray(a) || !Array.isArray(b)) return false

  return _.isEqual(a.sort(), b.sort())
}

class Policy {
  constructor(raw) {
    if (!raw) throw new Error("Empty policy payload");
    if (!raw.type && !raw['i.type']) throw new Error("Invalid policy payload");
    if (raw.type == 'internet') throw new Error(`Invalid policy type ${raw.type}`);

    Object.assign(this, raw);

    this.parseRedisfyArray(raw);

    if (this.scope) {
      // convert vpn profiles in "scope" field to "vpnProfile" field
      const vpnProfiles = this.scope.filter(v => v.startsWith(`${Constants.NS_VPN_PROFILE}:`)).map(v => v.substring(`${Constants.NS_VPN_PROFILE}:`.length));
      this.scope = this.scope.filter(v => !v.startsWith(`${Constants.NS_VPN_PROFILE}:`));
      this.vpnProfile = (this.vpnProfile || []).concat(vpnProfiles).filter((v, i, a) => a.indexOf(v) === i);
      if (!_.isArray(this.scope) || _.isEmpty(this.scope))
        delete this.scope;
      if (!_.isArray(this.vpnProfile) || _.isEmpty(this.vpnProfile))
        delete this.vpnProfile;
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
      this.avgPacketBytes === policy.avgPacketBytes &&
      this.parentRgId === policy.parentRgId &&
      this.targetRgId === policy.targetRgId &&
      // ignore scope if type is mac
      (this.type == 'mac' && hostTool.isMacAddress(this.target) || arraysEqual(this.scope, policy.scope)) &&
      arraysEqual(this.tag, policy.tag) &&
      arraysEqual(this.vpnProfile, policy.vpnProfile)
    ) {
      return true
    }

    return false
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
    const interval = cronParser.parseExpression(cronTime, { tz: sysManager.getTimezone() });
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
      this.vpnProfile &&
      _.isArray(this.vpnProfile) &&
      !_.isEmpty(this.vpnProfile) &&
      alarm['p.device.vpnProfile'] &&
      !this.vpnProfile.includes(alarm['p.device.vpnProfile'])
    ) {
      return false; // vpn profile not match
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

  redisfyArray(p) {
    for (const key of Policy.ARRAR_VALUE_KEYS) {
      if (p[key]) {
        if (p[key].length > 0)
          p[key] = JSON.stringify(p[key]);
        else
          delete p[key];
      }
    }
  }

  parseRedisfyArray(raw) {
    for (const key of Policy.ARRAR_VALUE_KEYS) {
      if (raw[key]) {
        if (_.isString(raw[key])) {
          try {
            this[key] = JSON.parse(raw[key])
          } catch (e) {
            log.error(`Failed to parse policy ${key} string:`, raw[key], e)
          }
        } else if (_.isArray(raw[key])) {
          this[key] = Array.from(raw[key]); // clone array to avoide side effects
        } else {
          log.error(`Unsupported ${key}`, raw[key])
        }

        if (!_.isArray(this[key]) || _.isEmpty(this[key]))
          delete this[key];
      }
    }
  }

  // return a new object ready for redis writing
  redisfy() {
    let p = JSON.parse(JSON.stringify(this))

    // convert array to string so that redis can store it as value
    this.redisfyArray(p);

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

Policy.ARRAR_VALUE_KEYS = ["scope", "tag", "vpnProfile", "applyRules"];
Policy.INTF_PREFIX = "intf:";
Policy.TAG_PREFIX = "tag:";

module.exports = Policy
