/*    Copyright 2020-2022 Firewalla Inc.
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
const sem = require('./SensorEventManager.js').getInstance();
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();
const execAsync = require('child-process-promise').exec;
const scheduler = require('../extension/scheduler/scheduler.js');
const f = require('../net2/Firewalla.js');
const DNSTool = require('../net2/DNSTool.js');
const dnsTool = new DNSTool();
const {Address4, Address6} = require('ip-address');
const Constants = require('../net2/Constants.js');

class RuleCheckSensor extends Sensor {
  constructor(config) {
    super(config);
    this.ipsetCache = {
      "block_ip_set": null,
      "sec_block_ip_set": null,
      "allow_ip_set": null,
      "block_net_set": null,
      "sec_block_net_set": null,
      "allow_net_set": null,
      "block_domain_set": null,
      "sec_block_domain_set": null,
      "allow_domain_set": null,
      "block_ib_ip_set": null,
      "allow_ib_ip_set": null,
      "block_ib_net_set": null,
      "allow_ib_net_set": null,
      "block_ib_domain_set": null,
      "allow_ib_domain_set": null,
      "block_ob_ip_set": null,
      "allow_ob_ip_set": null,
      "block_ob_net_set": null,
      "allow_ob_net_set": null,
      "block_ob_domain_set": null,
      "allow_ob_domain_set": null,
      "block_ip_set6": null,
      "sec_block_ip_set6": null,
      "allow_ip_set6": null,
      "block_net_set6": null,
      "sec_block_net_set6": null,
      "allow_net_set6": null,
      "block_domain_set6": null,
      "sec_block_domain_set6": null,
      "allow_domain_set6": null,
      "block_ib_ip_set6": null,
      "allow_ib_ip_set6": null,
      "block_ib_net_set6": null,
      "allow_ib_net_set6": null,
      "block_ib_domain_set6": null,
      "allow_ib_domain_set6": null,
      "block_ob_ip_set6": null,
      "allow_ob_ip_set6": null,
      "block_ob_net_set6": null,
      "allow_ob_net_set6": null,
      "block_ob_domain_set6": null,
      "allow_ob_domain_set6": null
    }
  }

  _clearIpsetCache() {
    for (const set in this.ipsetCache)
      this.ipsetCache[set] = null;
  }

  async _readIpsetEntries(set) {
    if (!set || !Object.keys(this.ipsetCache).includes(set)) {
      log.error(`Ipset ${set} is not supported for checking`);
      return [];
    }
    if (this.ipsetCache[set] === null) {
      this.ipsetCache[set] = await execAsync(`sudo ipset list ${set}`).then((result) => result.stdout && result.stdout.split("\n").filter(l => l && l.length > 0) || []).catch((err) => {
        log.error(`Failed to read entries from ipset ${set}`, err.message);
        return [];
      });
    }
    return this.ipsetCache[set];
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      setTimeout(() => {
        let interval = (this.config.interval || 10) * 60 * 1000; // 10 minute
        setInterval(() => {
          this._clearIpsetCache();
          this.checkRules();
        }, interval);
      }, 20 * 60 * 1000);
    })
  }

  async checkRules() {
    if (await pm2.isDisableAll()) {
      return; // temporarily by DisableAll flag
    }

    let policies = await pm2.loadActivePoliciesAsync({ includingDisabled: 1 });
    for (const policy of policies) {
      const needCheckActive = await this.needCheckActive(policy);
      if (needCheckActive) {
        await this.checkActiveRule(policy);
      }
    }
  }

  async needCheckActive(policy) {
    if (policy.type && ["ip", "net", "domain", "dns"].includes(policy.type)) {
      // other rule types have separate rules
      if (policy.action === "qos")
        return false;
      if (policy.action === "route")
        return false;
      if (policy.action === "match_group")
        return false;
      if (policy.disabled == 1) {
        return false;
      }
      if (policy.dnsmasq_only)
        return false;
      if (Number.isInteger(policy.ipttl))
        return false;
      // device level rule has separate rule in iptables
      if (policy.scope && policy.scope.length > 0) {
        return false;
      }
      // network/group level rule has separate rule in iptables
      if (policy.tag && policy.tag.length > 0) {
        return false;
      }
      // vpn profile rule has separate rule in iptables
      if (policy.guids && policy.guids.length > 0) {
        return false;
      }
      // rule group rule has separate chain in iptables
      if (policy.parentRgId && policy.parentRgId.length > 0) {
        return false;
      }
      // non-regular rule has separate rule in iptables
      let seq = policy.seq;
      if (!seq) {
        seq = Constants.RULE_SEQ_REG;
        if (pm2._isActiveProtectRule(policy))
          seq = Constants.RULE_SEQ_HI;
        if (pm2._isInboundAllowRule(policy))
          seq = Constants.RULE_SEQ_LO;
        if (pm2._isInboundFirewallRule(policy))
          seq = Constants.RULE_SEQ_LO;
      }
      if (seq !== Constants.RULE_SEQ_REG)
        return false;
      // do not check expired rules
      if (policy.expire) {
        if (policy.willExpireSoon() || policy.isExpired()) {
          return false;
        }
      }
      // do not check rules that are not scheduled to be effective
      if (policy.cronTime) {
        const x = scheduler.shouldPolicyBeRunning(policy);
        if (x <= 0)
          return false;
      }
      // there is a separate rule for rule that has specified local/remote port
      if (policy.localPort || policy.remotePort) {
        return false;
      }
      return true;
    }
    return false;
  }

  async checkIpSetHasEntry(targets, ipset) {
    if (!targets || !ipset)
      return true;
    const entries = await this._readIpsetEntries(ipset);
    if (entries && Array.isArray(entries)) {
      return targets.filter(t => !entries.includes(t)).length === 0;
    }
    return true;
  }

  async checkActiveRule(policy) {
    const type = policy["i.type"] || policy["type"];
    if (pm2.isFirewallaOrCloud(policy)) {
      return;
    }

    let needEnforce = false;
    let { pid, scope, target, action = "block", tag, remotePort, localPort, protocol, direction, upnp, guids, seq } = policy;
    if (scope && scope.length > 0)
      return;
    if (tag && tag.length > 0)
      return;
    if (guids && guids.length > 0)
      return;
    if (localPort || remotePort)
      return;
    if (!target)
      return;

    log.debug(`Checking rule enforcement ${pid}`);

    const security = policy.isSecurityBlockPolicy();

    switch (type) {
      case "ip":
      case "net": {
        if (!new Address4(target).isValid() && !new Address6(target).isValid())
          return;
        if (type === "net") {
          if (new Address4(target).isValid()) {
            const addr4 = new Address4(target);
            target = `${addr4.startAddress().addressMinusSuffix}${addr4.subnet === "/32" ? "" : addr4.subnet}`;
          } else {
            const addr6 = new Address6(target);
            target = `${addr6.startAddress().addressMinusSuffix}${addr6.subnet === "/128" ? "" : addr6.subnet}`;
          }
        }
        const set = (security ? 'sec_' : '' )
          + (action === "allow" ? 'allow_' : 'block_')
          + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : ""))
          + type + "_set" + (new Address4(target).isValid() ? "" : "6");
        const result = await this.checkIpSetHasEntry([target], set);
        if (!result)
          needEnforce = true;
        break;
      }
      case "dns":
      case "domain": {
        let ips = (await dnsTool.getIPsByDomain(target)) || [];
        ips = ips.concat((await dnsTool.getIPsByDomainPattern(target)) || []);
        if (ips && ips.length > 0) {
          const ip4Addrs = ips && ips.filter((ip) => !f.isReservedBlockingIP(ip) && new Address4(ip).isValid());
          const ip6Addrs = ips && ips.filter((ip) => !f.isReservedBlockingIP(ip) && new Address6(ip).isValid());
          const set4 = (security ? 'sec_' : '' )
            + (action === "allow" ? 'allow_' : 'block_')
            + (direction === "inbound" ? "ib_" : (direction === "outbound" ? "ob_" : ""))
            + "domain_set";
          const set6 = `${set4}6`;
          const result = await this.checkIpSetHasEntry(ip4Addrs, set4) && await this.checkIpSetHasEntry(ip6Addrs, set6);
          if (!result)
            needEnforce = true;
        }
        break;
      }
      default:
    }

    if (needEnforce) {
      log.info(`Need to reenforce rule ${pid}`);
      await pm2.tryPolicyEnforcement(policy, 'reenforce', policy);
    }
  }
}

module.exports = RuleCheckSensor;
