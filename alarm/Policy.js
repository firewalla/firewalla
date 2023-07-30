/*    Copyright 2016-2022 Firewalla Inc.
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
const IdentityManager = require('../net2/IdentityManager.js');
const sysManager = require('../net2/SysManager.js');
const Alarm = require('./Alarm.js')

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
      // convert guids in "scope" field to "guids" field
      const guids = this.scope.filter(v => IdentityManager.isGUID(v));
      this.scope = this.scope.filter(v => hostTool.isMacAddress(v));
      this.guids = _.uniq((this.guids || []).concat(guids));
    }
    if (!_.isArray(this.scope) || _.isEmpty(this.scope))
      delete this.scope;
    if (!_.isArray(this.guids) || _.isEmpty(this.guids))
      delete this.guids;
    if (!_.isArray(this.tag) || _.isEmpty(this.tag))
      delete this.tag;

    this.upnp = false;
    if (raw.upnp)
      this.upnp = JSON.parse(raw.upnp);

    if (raw.seq) {
      this.seq = Number(raw.seq);
    }

    if (raw.priority)
      this.priority = Number(raw.priority);

    if (raw.transferredBytes)
      this.transferredBytes = Number(raw.transferredBytes);

    if (raw.transferredPackets)
      this.transferredPackets = Number(raw.transferredPackets);

    if (raw.avgPacketBytes)
      this.avgPacketBytes = Number(raw.avgPacketBytes);

    if (!_.isEmpty(raw.ipttl))
      this.ipttl = Number(raw.ipttl);

    this.dnsmasq_only = false;
    if (raw.dnsmasq_only)
      this.dnsmasq_only = !!JSON.parse(raw.dnsmasq_only);

    this.trust = false;
    if (raw.trust)
      this.trust = JSON.parse(raw.trust);

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

    if (raw.resolver === "") {
      delete this.resolver;
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

  isSchedulingPolicy() {
    return this.expire || this.cronTime;
  }

  isEqual(val1, val2) {
    if (val1 === val2) return true;
    // undefined and "" should be consider as equal for compatible purpose
    // "" will be undefined when get it from redis
    if (val1 === undefined && val2 === "") return true;
    if (val2 === undefined && val1 === "") return true;
    return false;
  }

  isEqualToPolicy(policy) {
    if (!policy) {
      return false
    }
    if (!(policy instanceof Policy))
      policy = new Policy(policy) // leverage the constructor for compatibilities conversion

    const compareFields = ["type", "target", "expire", "cronTime", "remotePort",
      "localPort", "protocol", "direction", "action", "upnp", "dnsmasq_only", "trust", "trafficDirection",
      "transferredBytes", "transferredPackets", "avgPacketBytes", "parentRgId", "targetRgId",
      "ipttl", "wanUUID", "owanUUID", "seq", "routeType", "resolver", "origDst", "origDport", "snatIP", "flowIsolation", "dscpClass"];

    for (const field of compareFields) {
      if (!this.isEqual(this[field], policy[field])) {
        return false;
      }
    }

    if (
      // ignore scope if type is mac
      (this.type == 'mac' && hostTool.isMacAddress(this.target) || arraysEqual(this.scope, policy.scope)) &&
      arraysEqual(this.tag, policy.tag) &&
      arraysEqual(this.guids, policy.guids)
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

  isSecurityBlockPolicy() {
    if (this.action !== 'block') {
      return false;
    }

    const alarm_type = this.alarm_type;

    const isSecurityPolicy = alarm_type && (["ALARM_INTEL", "ALARM_BRO_NOTICE", "ALARM_LARGE_UPLOAD"].includes(alarm_type));
    const isAutoBlockPolicy = this.method == 'auto' && this.category == 'intel';
    return isSecurityPolicy || isAutoBlockPolicy;
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
    log.debug(`Comparing policy:${this.pid} and alarm:${alarm.aid} ...`)

    if (this.isDisabled()) {
      log.debug(`mismatch, policy disabled`)
      return false
    }

    if (!alarm.needPolicyMatch()) {
      log.debug(`mismatch, invalid alarm type ${alarm.constructor.name}`)
      return false;
    }

    if ((this.action || "block") != "block") {
      log.debug(`mismatch, non block policy`)
      return false;
    }

    if (this.isExpired()) {
      log.debug(`mismatch, policy expired`)
      return false // always return unmatched if policy is already expired
    }
    if (this.cronTime && this.duration && !this.inSchedule(alarm.alarmTimestamp)) {
      log.debug(`mismatch, policy not on schedule`)
      return false;
    }

    if (this.direction === "inbound") {
      // default to outbound alarm
      if ((alarm["p.local_is_client"] || "1") === "1") {
        log.debug(`direction mismatch`)
        return false;
      }
    }

    if (
      this.scope &&
      _.isArray(this.scope) &&
      !_.isEmpty(this.scope) &&
      !this.scope.some(mac => alarm['p.device.mac'] === mac)
    ) {
      log.debug(`mac doesn't match`)
      return false; // scope not match
    }

    if (
      this.guids &&
      _.isArray(this.guids) &&
      !_.isEmpty(this.guids) &&
      this.guids.filter(guid => {
        const identity = IdentityManager.getIdentityByGUID(guid);
        if (identity) {
          const key = identity.constructor.getKeyOfUIDInAlarm();
          if (alarm[key] && alarm[key] === identity.getUniqueId())
            return true;
        }
        return false;
      }).length === 0
    ) {
      log.debug(`identity doesn't match`)
      return false; // vpn profile not match
    }

    let tagNoMatched = false; // check if group or network matched or not
    if (
      this.tag &&
      _.isArray(this.tag) &&
      !_.isEmpty(this.tag) &&
      !this.tag.some(t => _.has(alarm, 'p.intf.id') && t === Policy.INTF_PREFIX + alarm['p.intf.id'])
    ) {
      log.debug(`interface doesn't match`)
      tagNoMatched = true; // tag not match
    }
    if (
      this.tag &&
      _.isArray(this.tag) &&
      !_.isEmpty(this.tag) &&
      !this.tag.some(t => _.has(alarm, 'p.tag.ids') && !_.isEmpty(alarm['p.tag.ids']) && alarm['p.tag.ids'].some(tid => t === Policy.TAG_PREFIX + tid))
    ) {
      log.debug(`tag doesn't match`)
      tagNoMatched = true;
    }

    if (tagNoMatched) return false; // if group or network not matched, means policy not matched, return false;

    if (this.localPort && alarm['p.device.port']) {
      const notInRange = this.portInRange(this.localPort, alarm['p.device.port']);
      if (!notInRange) return false;
    }

    if (this.remotePort && alarm['p.dest.port']) {
      const notInRange = this.portInRange(this.remotePort, alarm['p.dest.port']);
      if (!notInRange) return false;
    }

    if (alarm instanceof Alarm.BroNoticeAlarm &&
      alarm['p.noticeType'] == 'SSH::Password_Guessing' &&
      sysManager.isMyIP(alarm['p.dest.ip'])
    ) {
      log.debug('mismatch, special case for SSH guessing')
      return false
    }

    // for each policy type
    switch (this.type) {
      case "ip":
        if (alarm['p.dest.ip']) {
          return this.target === alarm['p.dest.ip']
        } else {
          return false
        }
      case "net":
        if (alarm['p.dest.ip']) {
          return iptool.cidrSubnet(this.target).contains(alarm['p.dest.ip'])
        } else {
          return false
        }

      case "dns":
      case "domain":
        if (alarm['p.dest.name']) {
          return minimatch(alarm['p.dest.name'], `*.${this.target}`) ||
            alarm['p.dest.name'] === this.target
        } else {
          return false
        }

      case "mac":
        if (hostTool.isMacAddress(this.target)) {
          if (alarm['p.device.mac']) {
            return alarm['p.device.mac'] === this.target
          } else {
            return false
          }
        } else {
          // type:mac target: TAG 
          // block internet on group/network
          // already matched p.tag.ids/p.intf.id above, return true directly here
          if (alarm['p.device.mac'] && !sysManager.isMyMac(alarm['p.device.mac'])) // rules do not take effect on the box itself. This check can prevent alarms that do not have p.device.mac from being suppressed, e.g., SSH password guess on WAN
            return true
          else
            return false
        }

      case "category":
        if (alarm['p.dest.category']) {
          return alarm['p.dest.category'] === this.target;
        } else {
          return false;
        }

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
      case "remotePort":
        if (alarm['p.dest.port']) {
          return this.portInRange(this.target, alarm['p.dest.port'])
        } else {
          return false;
        }
      case 'country':
        if (alarm['p.dest.country']) {
          return alarm['p.dest.country'] == this.target;
        } else {
          return false;
        }
      default:
        return false
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

Policy.ARRAR_VALUE_KEYS = ["scope", "tag", "guids", "applyRules"];
Policy.INTF_PREFIX = "intf:";
Policy.TAG_PREFIX = "tag:";

module.exports = Policy
