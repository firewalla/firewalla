/*    Copyright 2020 Firewalla INC 
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
const Sensor = require('./Sensor.js').Sensor;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();
const execAsync = require('child-process-promise').exec;
const Block = require('../control/Block.js');
const util = require('util');
const scheduler = require('../extension/scheduler/scheduler.js')();
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');
const iptool = require('ip')

class BlockRuleCheckSensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      let interval = (this.config.interval || 10) * 60 * 1000; // 10 minute
      setInterval(() => {
        this.checkBlockRules();
      }, interval);
    })
  }

  async checkBlockRules() {
    log.info("Start check block rule");
    if (await pm2.isDisableAll()) {
      return; // temporarily by DisableAll flag
    }

    let policies = await pm2.loadActivePoliciesAsync({ includingDisabled: 1 });
    for (const policy of policies) {
      const needCheckActive = await this.needCheckActive(policy);
      if (needCheckActive) {
        await this.checkActiveBlockRule(policy);
      }
    }
  }

  async needCheckActive(policy) {
    if (policy.disabled == 1) {
      return false;
    }
    if (policy.expire) {
      if (policy.willExpireSoon()) {
        return false;
      } else {
        return !(policy.isExpired());
      }
    } else if (policy.cronTime) {
      const x = scheduler.shouldPolicyBeRunning(policy);
      return (x > 0) ? true : false;
    } else {
      return true;
    }
  }

  async checkIptableHasSetRule(ipsetName) {
    const check_cmd = util.format("sudo iptables -S | grep %s", ipsetName);
    try {
      const result = await execAsync(check_cmd);
      if (result.stdout != "") return true;
      return false;
    } catch (err) {
      return false;
    }
  }

  async checkIpSetHasEntry(targets, ipset) {
    if (!targets || !ipset)
      return true;
    const check_cmd = util.format('sudo ipset list %s', ipset);
    try {
      const result = await execAsync(check_cmd);
      for (const target of targets || []) {
        if (result.stdout.indexOf(target) == -1) {
          return false;
        }
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  async checkActiveBlockRule(policy) {
    const type = policy["i.type"] || policy["type"];
    if (pm2.isFirewallaOrCloud(policy)) {
      return;
    }

    let needEnforce = false;
    let { pid, scope, target, whitelist } = policy;
    if (scope) {
      let ipsetName = Block.getMacSet(pid);
      let hasIpSetEntry = await this.checkIpSetHasEntry(scope, ipsetName);
      let hasIptableRule = true;
      if (hasIpSetEntry) {
        hasIptableRule = await this.checkIptableHasSetRule(ipsetName);
      }
      if (!hasIpSetEntry || !hasIptableRule) {
        needEnforce = true;
      }
    } else if (type == "ip") {
      let ipsetName = (whitelist ? 'whitelist_ip_set' : 'blocked_ip_set');
      let hasIpSetEntry = await this.checkIpSetHasEntry([target], ipsetName);
      if (!hasIpSetEntry) {
        needEnforce = true;
      }
    } else if (type == "dns") {
      let hasIpSetEntry = true;
      const key = `rdns:domain:${target}`;
      let results = await rclient.zrevrangebyscoreAsync(key, '+inf', '-inf');
      if (results) {
        results = results && results.filter((ip) => !f.isReservedBlockingIP(ip) && iptool.isV4Format(ip));
        let ipsetName = (whitelist ? 'whitelist_domain_set' : 'blocked_domain_set');
        hasIpSetEntry = await this.checkIpSetHasEntry(results, ipsetName);
      } else {
        hasIpSetEntry = false;
      }
      if (!hasIpSetEntry) {
        needEnforce = true;
      }
    }

    if (needEnforce) {
      log.info("Need reenforce policy:", pid);
      await pm2.tryPolicyEnforcement(policy, 'reenforce', policy);
    }
  }
}

module.exports = BlockRuleCheckSensor;
