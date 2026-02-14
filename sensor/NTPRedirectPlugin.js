/*    Copyright 2023-2026 Firewalla Inc.
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
const rclient = require('../util/redis_manager.js').getRedisClient()
const fc = require('../net2/config.js')
const MonitorablePolicyPlugin = require('./MonitorablePolicyPlugin.js')
const NetworkProfile = require('../net2/NetworkProfile.js')
const { Rule } = require('../net2/Iptables.js');
const Constant = require('../net2/Constants.js')

const execAsync = require('child-process-promise').exec

const ipset = require('../net2/Ipset.js');
const iptc = require('../control/IptablesControl.js');

const PREROUTING_CHAIN = 'FW_PREROUTING'
const NTP_CHAIN = 'FW_PREROUTING_NTP'
const NTP_CHAIN_DNAT = 'FW_PREROUTING_NTP_DNAT'

class NTPRedirectPlugin extends MonitorablePolicyPlugin {
  constructor(config) {
    super(config)

    this.refreshInterval = (this.config.refreshInterval || 60) * 1000;
    this.ntpOffSet = new Set();
    this.lastNtpOffSetUpdateTime = 0;
    this.ntpOffSetUpdateInterval = 1000 * 60 * 60 * 4; // 4 hours

    // only request is DNATed
    this.ruleFeature = new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').dport(123)
      .set('monitored_net_set', 'src,src').set('acl_off_set', 'src,src', true).jmp(NTP_CHAIN)
    this.ruleFeature6 = this.ruleFeature.clone().fam(6)

    this.ruleNtpOff = new Rule('nat').chn(NTP_CHAIN_DNAT).set(ipset.CONSTANTS.IPSET_NTP_OFF, 'src,src').jmp('RETURN')
    this.ruleNtpOff6 = this.ruleNtpOff.clone().fam(6)

    // TODO: local NTP traffic is not distinguished here
    this.ruleLog = new Rule('nat').chn(NTP_CHAIN_DNAT).mdl('conntrack', '--ctstate NEW --ctdir ORIGINAL')
      .log(Constant.IPTABLES_LOG_PREFIX_AUDIT + 'A=RD D=O ')
    this.ruleLog6 = this.ruleLog.clone().fam(6)

    // -j DNAT --to-destination ::1 won't work on v6 as there's no equivalent for net.ipv4.conf.all.route_localnet
    // https://serverfault.com/questions/975558/nftables-ip6-route-to-localhost-ipv6-nat-to-loopback/975890#975890
    //
    // REDIRECT
    // This target is only valid in the nat table, in the PREROUTING and OUTPUT chains, and user-defined
    // chains which are only called from those chains. It redirects the packet to the machine itself by
    // changing the destination IP to the primary address of the incoming interface (locally-generated
    // packets are mapped to the 127.0.0.1 address).
    this.ruleDNAT = new Rule('nat').chn(NTP_CHAIN_DNAT).jmp('REDIRECT')
    this.ruleDNAT6 = this.ruleDNAT.clone().fam(6)

    this.localServerStatus = true
  }

  async run() {
    await super.run();
    // keep ntpd working in orphan mode even if external peers are not available, in most cases the time on the box should be accurate
    // this is to avoid suspending NTP intercept, which may cause NTP flows being blocked if there is another internet block rule
    await execAsync(String.raw`sudo bash -c 'grep -q "^tos orphan" /etc/ntp.conf || echo "tos orphan 10" >> /etc/ntp.conf'`).catch(()=>{});
    await execAsync(String.raw`sudo sed -i -E 's/(^restrict .*)limited(.*$)/\1\2/' /etc/ntp.conf; sudo systemctl restart ntp`).catch(()=>{});
  }

  async updateNtpOff(mac, op='add', updateRedis=false, useTemp=false) {
    if (!mac) return;

    if (updateRedis === true) {
      if (op === 'add') {
        const now = Math.floor(Date.now() / 1000);
        await rclient.zaddAsync(Constant.REDIS_KEY_NTP_OFF_SET, now, mac).catch((err) => {
          log.error(`Failed to store ${mac} to NTP off set`, err);
        });
      } else if (op === 'del') {
        await rclient.zremAsync(Constant.REDIS_KEY_NTP_OFF_SET, mac).catch((err) => {
          log.error(`Failed to remove ${mac} from NTP off set`, err);
        });
      }
    }

    const ipsetName = useTemp ? `${ipset.CONSTANTS.IPSET_NTP_OFF_MAC}_TEMP` : ipset.CONSTANTS.IPSET_NTP_OFF_MAC;
    if (op === 'add') {
      if (this.ntpOffSet.has(mac))
        return;
      this.ntpOffSet.add(mac);
      ipset.add(ipsetName, mac);
    } else if (op === 'del') {
      if (!this.ntpOffSet.has(mac))
        return;
      this.ntpOffSet.delete(mac);
      ipset.del(ipsetName, mac);
    }
  }

  async swapIpset() {
    const ipsetName = ipset.CONSTANTS.IPSET_NTP_OFF_MAC;
    const tmpIPSetName = `${ipsetName}_TEMP`;

    ipset.swap(ipsetName, tmpIPSetName);
    ipset.flush(tmpIPSetName);
  }

  async syncNtpOffSet() {
    const now = Date.now();
    if (now - this.lastNtpOffSetUpdateTime < this.ntpOffSetUpdateInterval)
      return;

    const ntpOffSetEntries = await rclient.zrangeAsync(Constant.REDIS_KEY_NTP_OFF_SET, 0, -1).catch((err) => {
      log.error(`Failed to load NTP off set from redis`, err);
      return [];
    });
    if (ntpOffSetEntries.length === 0)
      return;

    this.ntpOffSet.clear();
    for (const mac of ntpOffSetEntries) {
      await this.updateNtpOff(mac, 'add', false, true);
    }

    await this.swapIpset();
    this.lastNtpOffSetUpdateTime = now;
  }

  async cleanupNtpOffSet() {
    const ipsetName = ipset.CONSTANTS.IPSET_NTP_OFF_MAC;
    ipset.flush(ipsetName);
    this.ntpOffSet.clear();
  }

  async job(retry = 5) {
    super.job()

    if (!fc.isFeatureOn(this.config.featureName)) return

    while (retry--)
      try {
        await execAsync('ntpdate -q localhost')
        if (!this.localServerStatus)
          log.info('NTP is back online on localhost')
        iptc.addRule(this.ruleFeature.opr('-A'));
        iptc.addRule(this.ruleFeature6.opr('-A'));
        await rclient.setAsync(Constant.REDIS_KEY_NTP_SERVER_STATUS, 1)
        this.localServerStatus = true
        await this.syncNtpOffSet();
        return
      } catch(err) {
        (this.localServerStatus ? log.warn : log.verbose)('NTP not available on localhost, retries left', retry)
        log.debug(err.message)
      }

    if (this.localServerStatus)
      log.error('Local NTP down, removing redirection')
    iptc.addRule(this.ruleFeature.opr('-D'));
    iptc.addRule(this.ruleFeature6.opr('-D'));
    await rclient.setAsync(Constant.REDIS_KEY_NTP_SERVER_STATUS, 0)
    this.localServerStatus = false
  }

  async applyMonitorable(m, setting) {
    if (!(m instanceof NetworkProfile)) {
      if (setting !== 0)
        log.warn(`Policy on ${m.constructor.getClassName()}:${m.getGUID()} not supported`)
      return
    }

    await NetworkProfile.ensureCreateEnforcementEnv(m.getUniqueId())

    const ruleBase = new Rule('nat').chn(NTP_CHAIN)
      .set(NetworkProfile.getNetIpsetName(m.getUniqueId()), 'src,src')
    const ruleEnable = ruleBase.clone().jmp(NTP_CHAIN_DNAT)
    const ruleDisable = ruleBase.clone().jmp('RETURN')

    const ruleBase6 = new Rule('nat').chn(NTP_CHAIN).fam(6)
      .set(NetworkProfile.getNetIpsetName(m.getUniqueId(), 6), 'src,src')
    const ruleEnable6 = ruleBase6.clone().jmp(NTP_CHAIN_DNAT)
    const ruleDisable6 = ruleBase6.clone().jmp('RETURN')

    if (setting == 1) { // positive
      iptc.addRule(ruleEnable.opr('-I'));
      iptc.addRule(ruleEnable6.opr('-I'));
      iptc.addRule(ruleDisable.opr('-D'));
      iptc.addRule(ruleDisable6.opr('-D'));
    } else if (setting == -1) { // negative
      iptc.addRule(ruleEnable.opr('-D'));
      iptc.addRule(ruleEnable6.opr('-D'));
      iptc.addRule(ruleDisable.opr('-I'));
      iptc.addRule(ruleDisable6.opr('-I'));
    } else if (setting == 0) { // neutral/reset
      iptc.addRule(ruleEnable.opr('-D'));
      iptc.addRule(ruleEnable6.opr('-D'));
      iptc.addRule(ruleDisable.opr('-D'));
      iptc.addRule(ruleDisable6.opr('-D'));
    }
  }

  async systemStart() {
    const rule = new Rule('nat').chn(NTP_CHAIN).jmp(NTP_CHAIN_DNAT)
    iptc.addRule(rule);
    iptc.addRule(rule.fam(6));
  }

  async systemStop() {
    const rule = new Rule('nat').chn(NTP_CHAIN).jmp(NTP_CHAIN_DNAT)
    iptc.addRule(rule.opr('-D'));
    iptc.addRule(rule.fam(6).opr('-D'));
  }

  // consider using iptables-restore/scripts if complexity goes up
  async globalOn() {
    iptc.addRule(new Rule('nat').chn(NTP_CHAIN).opr('-N'));
    iptc.addRule(new Rule('nat').chn(NTP_CHAIN).fam(6).opr('-N'));
    iptc.addRule(new Rule('nat').chn(NTP_CHAIN_DNAT).opr('-N'));
    iptc.addRule(new Rule('nat').chn(NTP_CHAIN_DNAT).fam(6).opr('-N'));
    iptc.addRule(this.ruleFeature.opr('-A'));
    iptc.addRule(this.ruleFeature6.opr('-A'));
    iptc.addRule(this.ruleNtpOff.opr('-A'));
    iptc.addRule(this.ruleNtpOff6.opr('-A'));
    iptc.addRule(this.ruleLog.opr('-A'));
    iptc.addRule(this.ruleLog6.opr('-A'));
    iptc.addRule(this.ruleDNAT.opr('-A'));
    iptc.addRule(this.ruleDNAT6.opr('-A'));

    // create temp ipset
    ipset.create(`${ipset.CONSTANTS.IPSET_NTP_OFF_MAC}_TEMP`, 'hash:mac');
    await this.syncNtpOffSet();

    await super.globalOn()
    // start a quick check right away
    await this.job(1)
  }

  async globalOff() {
    iptc.addRule(this.ruleFeature.opr('-D'));
    iptc.addRule(this.ruleFeature6.opr('-D'));
    // no need to touch FW_PREROUTING_NTP_DNAT chain here

    if (this.adminSystemSwitch) {
      ipset.destroy(`${ipset.CONSTANTS.IPSET_NTP_OFF_MAC}_TEMP`);
    }
    await super.globalOff()
  }
}

module.exports = NTPRedirectPlugin;
