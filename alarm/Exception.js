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

var extend = require('util')._extend

const minimatch = require('minimatch')

const _ = require('lodash')

const validator = require('validator');

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
  constructor(rules) {
    // FIXME: ignore any rules not begin with prefix "p"
    extend(this, rules);
    this.timestamp = new Date() / 1000;
  }

  getMatchingKeys() {
    let keys = []
    for(let k in this) {
      if (k === "type" || k.startsWith("p.")) {
        keys.push(k)
      }
    }

    return keys.sort()
  }

  isEqualToException(e) {
    const thisKeys = this.getMatchingKeys()
    const thatKeys = e.getMatchingKeys()

    if(!arraysEqual(thisKeys, thatKeys)) {
      return false
    }
    for(let i in thisKeys) {
      let k = thisKeys[i]
      if (this[k] !== e[k]) {
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
  
  match(alarm) {

    let matched = false;
    // FIXME: exact match only for now, and only supports String
    for (var key in this) {

      if(!key.startsWith("p.") && key !== "type") {
        continue;
      }

      var val = this[key];
      if(!alarm[key]) return false;
      let val2 = alarm[key];

      if(key === "type" && val === "ALARM_INTEL" && this.isSecurityAlarm(alarm)) {
        matched = true;
        continue;
      }

      if ((this["json." + key] == true || this["json." + key] == "true") && val && validator.isJSON(val)) {
        if (this.jsonComparisonMatch(val, val2)) {
          matched = true;
          continue;
        }
      }

      //special exception
      if (key === "p.upnp.description") {
        if (val.endsWith("*")) {
          if (minimatch(val2, val)) {
            matched = true;
            continue;
          }
        }
      }

      if (key === "p.tag.ids") {
        const intersect = _.intersection(val, val2);
        if (intersect.length > 0) {
          matched = true;
          continue;
        }
      }

      if(val.startsWith("*.")) {
        // use glob matching
        if(!minimatch(val2, val) && // NOT glob match
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
            if(!ip.cidrSubnet(val).contains(val2)) {
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
          if(val2 !== val) return false;
        }
      }

      matched = true;
    }

    return matched;
  }
}
