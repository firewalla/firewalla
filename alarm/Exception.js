/*    Copyright 2016-2019 Firewalla INC
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
let ip = require('ip')


const minimatch = require('minimatch')

const _ = require('lodash')

const validator = require('validator');

const CategoryMatcher = require('./CategoryMatcher');

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

function isJsonString(str) {
  return _.isString(str) && validator.isJSON(str)
}

module.exports = class {
  constructor(raw) {
    const numberKeys = ["timestamp", "expireTs", "idleTs"]
    for (const key in raw) {
      if (isJsonString(raw[key])) {
        // parse will always be successful if passed check
        raw[key] = JSON.parse(raw[key])
      }
      if (numberKeys.includes(key))
        raw[key] = !isNaN(raw[key]) && Number(raw[key]);
      if (key == 'p.tag.ids' && Array.isArray(raw[key])) {
        raw[key] = raw[key].map(String) //Backward compatibility
      }
      if ((/^p\.tag\.ids\.[0-9]+$/).test(key)) {
        log.debug('legacy field found', key, raw[key])
        this['p.tag.ids'] = this['p.tag.ids'] || []
        this['p.tag.ids'].push(raw[key])
        delete raw[key]
      }
    }
    Object.assign(this, raw);

    if (!this.timestamp) this.timestamp = new Date() / 1000;
  }

  getMatchingKeys() {
    let keys = ["cronTime", "duration", "expireTs", "idleTs"]
    for (let k in this) {
      if (k === "type" || k.startsWith("p.") || k.startsWith("e.")) {
        keys.push(k)
      }
    }

    return keys.sort()
  }

  isEqualToException(e) {
    const thisKeys = this.getMatchingKeys()
    const thatKeys = e.getMatchingKeys()

    if (!arraysEqual(thisKeys, thatKeys)) {
      return false
    }
    for (let i in thisKeys) {
      let k = thisKeys[i]
      if (!_.isEqual(this[k], e[k])) {
        return false
      }
    }

    return true
  }

  isSecurityAlarm(alarm) {
    const securityAlarmTypes = [
      "ALARM_SPOOFING_DEVICE",
      "ALARM_BRO_NOTICE",
      "ALARM_INTEL",
      "ALARM_VULNERABILITY"
    ];

    return securityAlarmTypes.includes(alarm.type);
  }

  jsonComparisonMatch(val, val2) {
    if (!isFinite(val2)) return false;
    let comparison = JSON.parse(val);
    if (isFinite(comparison["$gt"])) {
      if (val2 > comparison["$gt"]) {
        return true;
      }
    } else if (isFinite(comparison["$lt"])) {
      if (val2 < comparison["$lt"]) {
        return true;
      }
    } else if (isFinite(comparison["$gte"])) {
      if (val2 > comparison["$gte"] || val2 == comparison["$gte"]) {
        return true;
      }
    } else if (isFinite(comparison["$lte"])) {
      if (val2 < comparison["$lte"] || val2 == comparison["$lte"]) {
        return true;
      }
    }

    return false;
  }

  valueMatch(val, val2) {
    //special exception
    if (val.endsWith("*")) {
      if (minimatch(val2, val)) {
        return true
      }
    }

    if (val.startsWith("*.")) {
      // use glob matching
      if (!minimatch(val2, val) && // NOT glob match
        val.slice(2) !== val2) { // NOT exact sub domain match
        return false
      }
    } else {
      let cidrParts = val.split("/", 2);
      if (cidrParts.length == 2) {
        let addr = cidrParts[0];
        let mask = cidrParts[1];
        if (ip.isV4Format(addr) && RegExp("^\\d+$").test(mask) && ip.isV4Format(val2)) {
          // try matching cidr subnet iff value in alarm is an ipv4 address and value in exception is a cidr notation
          if (!ip.cidrSubnet(val).contains(val2)) {
            return false;
          }
        }
      } else {
        // not a cidr subnet exception

        // alarm might has field in number
        // and assume exceptions are always loaded from redis before comparing
        if (_.isNumber(val2)) {
          val = _.toNumber(val)
          if (isNaN(val)) return false;
        }
        if (val2 !== val) return false;
      }
    }

    return true;
  }

  getCategory() {
    return this["p.category.id"];
  }

  setCategoryMatcher(matcher) {
    this.categoryMatcher = matcher;
  }

  isExpired() {
    if (this.expireTs)
      return Date.now() / 1000 > this.expireTs;
    else
      return false;
  }

  isIdle() {
    if (this.idleTs)
      return Date.now() / 1000 < this.idleTs;
    else
      return false;
  }

  match(alarm) {
    try {
      let matched = false;

      for (const key in this) {

        if (!key.startsWith("p.") && key !== "type" && !key.startsWith("e.")) {
          continue;
        }

        if (key === "p.category.id") {
          continue;
        }

        var val = this[key];
        if (!alarm[key]) return false;
        let val2 = alarm[key];

        if (key === "type" && val === "ALARM_INTEL" && this.isSecurityAlarm(alarm)) {
          matched = true;
          continue;
        }

        if ((this["json." + key] == true || this["json." + key] == "true") && val && validator.isJSON(val)) {
          if (this.jsonComparisonMatch(val, val2)) {
            matched = true;
            continue;
          }
        }
        let val2Array = val2;
        // Exception will be parsed at object creation
        // while alarm will always use string to avoid compatibility issue with clients
        isJsonString(val2) && (val2Array = JSON.parse(val2));

        if (key.startsWith("p.tag.ids")) {
          if (_.intersection(val, val2Array.map(String)).length > 0) {
            matched = true;
            continue;
          }
        }

        if (_.isArray(val)) {
          let matchInArray = false;
          for (const valCurrent of val) {
            if (this.valueMatch(valCurrent + "", val2)) {
              matchInArray = true;
              break;
            }
          }

          if (!matchInArray) {
            return false;
          }
        } else {
          if (!this.valueMatch(val, val2)) {
            return false;
          }
        }

        matched = true;
      }

      // match against category
      if (this.categoryMatcher) {
        if (this.getCategory() === alarm["p.dest.category"]) {
          // shortcut for direct category id match
          matched = true;
        } else {
          const targetDomain = alarm["p.dest.name"];
          const targetIP = alarm["p.dest.ip"];
          log.info(`Match dest domain ${targetDomain} and ip ${targetIP} against category ${this.getCategory()}`);
          if (targetDomain && this.categoryMatcher.matchDomain(targetDomain)) {
            matched = true;
          } else if (targetIP && this.categoryMatcher.matchIP(targetIP)) {
            matched = true;
          } else {
            return false;
          }
        }
      }

      return matched;
    } catch (e) {
      log.warn("Error on alarm matching", e);
      return false;
    }
  }
}
