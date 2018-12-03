'use strict'

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');
let Alarm = require('./Alarm.js')
let ip = require('ip')

var extend = require('util')._extend

const minimatch = require('minimatch')

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
          if(val2 !== val) return false;        
        }
      }

      matched = true;
    }
    
    return matched;
  }
}
