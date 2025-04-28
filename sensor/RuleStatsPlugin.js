/*    Copyright 2022-2025 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);
const PolicyManager2 = require('../alarm/PolicyManager2');
const pm2 = new PolicyManager2();
const DomainIPTool = require('../control/DomainIPTool');
const domainIpTool = new DomainIPTool();
const Sensor = require('./Sensor.js').Sensor;
const conntrack = require('../net2/Conntrack.js')

const sem = require('../sensor/SensorEventManager').getInstance();
const _ = require('lodash');
const scheduler = require('../util/scheduler');
const { Address4, Address6 } = require('ip-address');
const rclient = require('../util/redis_manager.js').getRedisClient();
const qos = require('../control/QoS');
const LRU = require('lru-cache');
const crypto = require('crypto');
const featureName = "rule_stats";

const KEY_RULE_STATS_INIT_TS = "sys:ruleStats:initTs"
class RuleStatsPlugin extends Sensor {
  run() {
    this.hookFeature(featureName);
    this.policyRulesMap = null;
    this.recordBuffer = [];
    this.cache = new LRU({
      max: 200,
      maxAge: 15 * 1000,
      updateAgeOnGet: false
    });
    sem.on("PolicyEnforcement", async (event) => {
      await this.loadBlockAllowGlobalRules();
    });
    this.on = false;
    void this.process();
  }

  async initRuleStatsFirstTimeOnBox() {
    const result = await rclient.existsAsync(KEY_RULE_STATS_INIT_TS);
    if (result === 0) {
      // this code will only run once on each box to reset rule stats.
      log.info("Clear all hit count data when this feature is first enabled");
      await pm2.resetStats();
      const currentTs = new Date().getTime() / 1000;
      // a flag to indicate that the box has inited rule stats
      await rclient.setAsync(KEY_RULE_STATS_INIT_TS, currentTs);
    }
  }

  async getFeatureFirstEnabledTimestamp() {
    const initTs = await rclient.getAsync(KEY_RULE_STATS_INIT_TS);
    if (initTs) {
      return parseFloat(initTs);
    } else {
      return 0;
    }
  }

  async globalOn() {
    await super.globalOn();
    await this.initRuleStatsFirstTimeOnBox()
    this.on = true;
  }

  async globalOff() {
    await super.globalOff();
    this.on = false;
    this.cache.reset();
  }

  async process() {
    while (true) {
      try {
        if (this.on) {
          await this.updateRuleStats();
        }
      } catch (e) {
        log.debug(e);
      }
      await scheduler.delay(1000);
    }
  }

  // Load global allow/block policy rules
  async loadBlockAllowGlobalRules() {
    if (!this.on) {
      return;
    }
    log.debug("Load policy rules for stats");
    const newPolicyRulesMap = new Map();
    const policyRules = await pm2.loadActivePoliciesAsync();
    log.debug(`${policyRules.length} rules active`);
    for (const policy of policyRules) {
      const action = policy.action;
      if (!newPolicyRulesMap.has(action)) {
        newPolicyRulesMap.set(action, []);
      }
      // filter on rules
      switch (action) {
        case "allow":
        case "block": {
          if (policy.disabled === "1") {
            continue;
          }
          // skip non global rules because they will already have their rule id logged.
          if (!_.isEmpty(policy.tags) || !_.isEmpty(policy.intfs) || !_.isEmpty(policy.scope) || !_.isEmpty(policy.guids) || policy.localPort || policy.remotePort) {
            continue;
          }

          if (!["dns", "domain", "ip", "net"].includes(policy.type)) {
            continue;
          }

          log.debug(`Add policy rule ${policy.pid} to global ${action} list`);
          newPolicyRulesMap.get(action).push(policy);
        }
      }
    }
    this.policyRulesMap = newPolicyRulesMap;
  }

  accountRule(record) {
    if (!this.on) {
      return;
    }
    // input drop is different than ingress firewall rule
    if (record.dir === "W") {
      return;
    }

    // ignore normal dnsmasq pass rule
    if (record.type === "dns" && record.ac !== "block" && record.pid === 0 && !record.global) {
      return;
    }

    // limit buf size to avoid cpu and memory overload
    if (this.recordBuffer.length < 2000) {
      this.recordBuffer.push(record);
    }
  }

  static cachekeyRecord(record) {
    // use cache to reduce computation and redis operation.
    const hash = crypto.createHash("md5");
    hash.update(String(record.ac));
    hash.update(String(record.type));
    hash.update(String(record.fd));
    hash.update(String(record.sec));
    if (record.type == 'dns') {
      hash.update(String(record.dn));
    } else {
      hash.update(String(record.dh));
    }
    hash.update(String(record.qmark));
    return hash.digest("hex");
  }

  async getMatchedPids(record){
    // use cache to reduce computation and redis operation.
    const key = RuleStatsPlugin.cachekeyRecord(record);
    const v = this.cache.get(key);
    let matchedPids;
    if (v) {
      matchedPids = v;
    } else {
      matchedPids = (await this.getPolicyIds(record)).map(Number)
      this.cache.set(key, matchedPids);
    }
    return matchedPids;
  }

  async updateRuleStats() {
    const recordBuffer = this.recordBuffer;
    this.recordBuffer = [];

    if (!this.policyRulesMap) {
      await this.loadBlockAllowGlobalRules();
    }

    const ruleStatMap = new Map();

    // Match record to policy id
    for (const record of recordBuffer) {
      log.debug("Determine policy rule id of record:", record);
      let matchedPids;
      if (record.pid) {
        matchedPids = [record.pid];
      } else {
        matchedPids = await this.getMatchedPids(record);
      }

      for (const pid of matchedPids) {
        log.debug("Matched policy rule: ", pid);
        let stat;
        if (ruleStatMap.has(pid)) {
          stat = ruleStatMap.get(pid);
        } else {
          stat = new RuleStat();
        }
        if (record.ct > 1) {
          stat.count += record.ct;
        } else {
          stat.count++;
        }
        if (record.ts > stat.lastHitTs) {
          stat.lastHitTs = record.ts;
        }
        ruleStatMap.set(pid, stat);
      }
    }

    // update rule status to redis
    const batch = rclient.batch();
    for (const [pid, stat] of ruleStatMap) {
      if (! await rclient.existsAsync(`policy:${pid}`)) {
        return;
      }
      batch.hincrby(`policy:${pid}`, "hitCount", stat.count);
      const lastHitTs = Number(await rclient.hgetAsync(`policy:${pid}`, "lastHitTs") || "0");
      if (stat.lastHitTs > lastHitTs) {
        batch.hset(`policy:${pid}`, "lastHitTs", String(stat.lastHitTs));
      }
    }
    await batch.execAsync();
  }

  async getPolicyIds(record) {
    switch (record.ac) {
      case "allow":
      case "block": {
        log.debug("Match policy id for allow/block record", record);
        let recordIp, addr4, addr6, connHost, recordDomain;
        const action = record.ac;
        let lookupSets = [];

        if (record.sec) {
          lookupSets.push("sec_block_domain_set");
        } else {
          lookupSets.push(`${action}_domain_set`);
          if (record.fd === "in") {
            lookupSets.push(`${action}_ob_domain_set`);
          }
          if (record.fd === "out") {
            lookupSets.push(`${action}_ib_domain_set`);
          }
        }

        if (!this.policyRulesMap.has(action)) {
          return [];
        }

        if (record.type === "dns") {
          recordDomain = record.dn;
        } else {
          recordIp = record.dh;
          addr4 = new Address4(recordIp);
          addr6 = new Address6(recordIp);
          connHost = await conntrack.getConnEntry(record.sh, record.sp[0], record.dh, record.dp, record.pr, 'host')
        }


        for (const policy of this.policyRulesMap.get(action)) {
          if (record.sec ^ policy.isSecurityBlockPolicy()) {
            continue;
          }

          const target = policy.target;

          switch (policy.type) {
            case 'dns':
            case 'domain':
              if (recordDomain && this.matchWildcardDomain(recordDomain, target)
                || record.af && this.matchWildcardDomain(Object.keys(record.af)[0], target)
                || connHost && this.matchWildcardDomain(connHost, target))
              {
                return [policy.pid];
              }
              break
            case 'ip':
              if (recordIp && recordIp === target) {
                return [policy.pid];
              }
              break
            case 'net':
              if (!recordIp) break
              if (addr4.isValid()) {
                const targetNet4 = new Address4(target);
                if (targetNet4.isValid() && addr4.isInSubnet(targetNet4))
                  return [policy.pid];
              } else if (addr6.isValid()) {
                const targetNet6 = new Address6(target);
                if (targetNet6.isValid() && addr6.isInSubnet(targetNet6))
                  return [policy.pid];
              }
              break
          }

          const needToMatchDomainIpset = (action === "allow" || !policy.dnsmasq_only)
            && ['dns', 'domain'].includes(policy.type) && record.type == 'ip';
          if (needToMatchDomainIpset) {
            for (const lookupSet of lookupSets) {
              log.debug(`Match ${recordIp} to domain ipset ${lookupSet}`);
              const setKey = domainIpTool.getDomainIPMappingKey(target, { blockSet: lookupSet });
              if (recordIp && await rclient.sismemberAsync(setKey, recordIp) == 1)
                return [policy.pid];
            }
          }

        }
        return [];

      }
      case "qos": {
        const downloadHandlerId = (record.qmark & qos.QOS_DOWNLOAD_MASK) >> 16;
        const uploadHandlerId = (record.qmark & qos.QOS_UPLOAD_MASK) >> 23;
        const downloadPolicyId = await qos.getPolicyForQosHandler(downloadHandlerId);
        const uploadPolicyId = await qos.getPolicyForQosHandler(uploadHandlerId);
        const result = [];
        if (downloadPolicyId) {
          result.push(downloadPolicyId);
        }
        if (uploadPolicyId) {
          result.push(uploadPolicyId);
        }
        return result;
      }
    }
  }

  matchWildcardDomain(domain, target) {
    if (domain === target) {
      return true;
    }
    const tokens = domain.split(".");
    for (let i = 1; i < tokens.length - 1; i++) {
      if (tokens.slice(i).join(".") === target) {
        return true;
      }
    }
    return false;
  }
}

class RuleStat {
  constructor() {
    this.count = 0;
    this.lastHitTs = 0;
  }
}

module.exports = RuleStatsPlugin;
