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

 'use strict';

const log = require('../net2/logger.js')(__filename, "info");
const util = require('util');
const ip = require('ip');
const minimatch = require('minimatch');

const rclient = require('../util/redis_manager.js').getRedisClient();

const RESULT_ALLOW = "allow";
const RESULT_BLOCK = "block";
const RESULT_ERROR = "error";

async function checkIpOrDomain(ipOrDomain) {
  if (ipOrDomain === null) {
    return {
      result: RESULT_ALLOW
    };
  }
  // match exceptions first
  const exceptions = await _loadExceptions();
  const matchedExceptions = [];
  exceptions.forEach((exception) => {
    if (ip.isV4Format(ipOrDomain)) {
      // try to match against "p.dest.ip" in exception
      if (exception["p.dest.ip"]) {
        if (_matchIp(exception["p.dest.ip"], ipOrDomain)) {
          matchedExceptions.push(exception);
        }
      }
    } else {
      // try to match against "p.dest.name" in exception
      if (exception["p.dest.name"]) {
        if (_matchDomain(exception["p.dest.name"], ipOrDomain)) {
          matchedExceptions.push(exception);
        }
      }
    }
  });
  if (matchedExceptions.length > 0) {
    return {
      result: RESULT_ALLOW,
      exceptions: matchedExceptions
    };
  }
  
  // then match rules
  const rules = await _loadRules();
  const matchedRules = [];
  rules.forEach((rule) => {
    if (ip.isV4Format(ipOrDomain)) {
      // try to match against policy whose type is "ip"
      if (rule.type === "ip") {
        if (_matchIp(rule.target, ipOrDomain)) {
          matchedRules.push(rule);
        }
      }
    } else {
      // try to match against policy whose type is "domain" or "dns"
      if (rule.type === "domain" || rule.type === "dns") {
        let target = rule.target;
        if (!rule.domainExactMatch) {
          // add wildcard to target for pattern match
          target = "*." + target;
        }
        if (_matchDomain(target, ipOrDomain)) {
          matchedRules.push(rule);
        }
      }
    }
  });
  if (matchedRules.length > 0) {
    return {
      result: RESULT_BLOCK,
      rules: matchedRules
    };
  }

  // fall through, return RESULT_ALLOW
  return {
    result: RESULT_ALLOW
  };
}

function _matchIp(cond, val) {
  // cond can be either an exact ip address or cidr subnet masks
  let cidrParts = cond.split("/", 2);
  if (cidrParts.length == 2) {
    let addr = cidrParts[0];
    let mask = cidrParts[1];
    if (ip.isV4Format(addr) && RegExp("^\\d+$").test(mask) && ip.isV4Format(val)) {
      // try matching cidr subnet iff val is an ipv4 address and cond is a cidr notation
      if(!ip.cidrSubnet(cond).contains(val)) {
        return false;
      }
    }
  } else {
    // not a cidr subnet condition
    return (cond === val);
  }
  return true;
}

function _matchDomain(cond, val) {
  // condcan be either an exact domain or with wildcard
  if (cond.startsWith("*.")) {
    return (minimatch(val, cond) || cond.slice(2) === val)
  } else {
    return (cond === val);
  }
}

async function _loadExceptions() {
  const exceptions = [];
  const exceptionIds = await rclient.smembersAsync("exception_queue");
  await Promise.all(exceptionIds.map(async eid => {
    const exception = await rclient.hgetallAsync("exception:" + eid);
    exceptions.push(exception);
  }));
  return exceptions;
}

async function _loadRules(){
  const rules = [];
  const ruleIds = await rclient.zrevrangeAsync("policy_active", 0, -1);
  await Promise.all(ruleIds.map(async rid => {
    const rule = await rclient.hgetallAsync("policy:" + rid);
    rules.push(rule);
  }));
  return rules;
}


module.exports = {
 checkIpOrDomain: checkIpOrDomain
};
