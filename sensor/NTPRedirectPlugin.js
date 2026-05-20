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

const IdentityManager = require('../net2/IdentityManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

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
    // create chains no matter feature is enabled or not
    // simple and minimal change as there's no feature guard on other iptables operations
    for (const chain of [NTP_CHAIN, NTP_CHAIN_DNAT])
      for (const fam of [4, 6])
        await iptc.addRule(new Rule('nat').chn(chain).fam(fam).opr('-N'));

    await super.run();

    // /etc/ntp.conf adjustments:
    // - tos orphan 10: keep ntpd working in orphan mode even if external peers are not available, in most cases
    //   the time on the box should be accurate. this is to avoid suspending NTP intercept, which may cause NTP
    //   flows being blocked if there is another internet block rule
    // - server 127.127.1.0 / fudge 127.127.1.0 stratum 10: enable local clock as fallback reference so ntpd
    //   stays synchronized in orphan mode
    // - strip `limited` from restrict lines so the local server answers redirected NTP queries without rate
    //   limiting
    await execAsync(String.raw`sudo bash -c '
      grep -q "^tos orphan" /etc/ntp.conf || echo "tos orphan 10" >> /etc/ntp.conf
      grep -q "^server 127.127.1.0" /etc/ntp.conf || echo "server 127.127.1.0" >> /etc/ntp.conf
      grep -q "^fudge 127.127.1.0" /etc/ntp.conf || echo "fudge 127.127.1.0 stratum 10" >> /etc/ntp.conf
      sed -i -E "s/(^restrict .*)limited(.*$)/\1\2/" /etc/ntp.conf
      systemctl restart ntp
    '`).catch(()=>{});
  }

  async updateNtpOff(devId, op='add', updateRedis=false, useTemp=false) {
    if (!devId) return;

    if (updateRedis === true) {
      if (op === 'add') {
        const now = Math.floor(Date.now() / 1000);
        await rclient.zaddAsync(Constant.REDIS_KEY_NTP_OFF_SET, now, devId).catch((err) => {
          log.error(`Failed to store ${devId} to NTP off set`, err);
        });
      } else if (op === 'del') {
        await rclient.zremAsync(Constant.REDIS_KEY_NTP_OFF_SET, devId).catch((err) => {
          log.error(`Failed to remove ${devId} from NTP off set`, err);
        });
      }
    }

    const ipsetName = useTemp ? `${ipset.CONSTANTS.IPSET_NTP_OFF}_TEMP` : ipset.CONSTANTS.IPSET_NTP_OFF;
    let devIpsets = new Set();
    if (hostTool.isMacAddress(devId)) {
      const Host = require('../net2/Host.js');
      Host.ensureCreateEnforcementEnv(devId);

      const ipSet4 = Host.getIpSetName(devId, 4);
      const ipSet6 = Host.getIpSetName(devId, 6);
      const macSet = Host.getMacSetName(devId);
      devIpsets.add(ipSet4);
      devIpsets.add(ipSet6);
      devIpsets.add(macSet);
    } else if (IdentityManager.isGUID(devId)) {
      const c = IdentityManager.getIdentityClassByGUID(devId);
      if (c) {
        const { ns, uid } = IdentityManager.getNSAndUID(devId);
        await c.ensureCreateEnforcementEnv(uid);
        const ipSet4 = c.getEnforcementIPsetName(uid, 4);
        const ipSet6 = c.getEnforcementIPsetName(uid, 6);
        devIpsets.add(ipSet4);
        devIpsets.add(ipSet6);
      }
    }
    if (devIpsets.size === 0) {
      log.error(`Cannot find remote sets for devId ${devId}`);
      return;
    }
    if (op === 'add') {
      if (this.ntpOffSet.has(devId))
        return;
      this.ntpOffSet.add(devId);
      for (const ipSet of devIpsets) {
        await ipset.add(ipsetName, ipSet);
      }
    } else if (op === 'del') {
      if (!this.ntpOffSet.has(devId))
        return;
      this.ntpOffSet.delete(devId);
      for (const ipSet of devIpsets) {
        await ipset.del(ipsetName, ipSet);
      }
    }
  }

  async swapIpset() {
    const ipsetName = ipset.CONSTANTS.IPSET_NTP_OFF;
    const tmpIPSetName = `${ipsetName}_TEMP`;

    await ipset.swap(ipsetName, tmpIPSetName);
    await ipset.flush(tmpIPSetName);
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
    for (const devId of ntpOffSetEntries) {
      await this.updateNtpOff(devId, 'add', false, true);
    }

    await this.swapIpset();
    this.lastNtpOffSetUpdateTime = now;
  }

  async cleanupNtpOffSet() {
    const ipsetName = ipset.CONSTANTS.IPSET_NTP_OFF;
    await ipset.flush(ipsetName);
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
        await iptc.addRule(this.ruleFeature.opr('-A'));
        await iptc.addRule(this.ruleFeature6.opr('-A'));
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
    await iptc.addRule(this.ruleFeature.opr('-D'));
    await iptc.addRule(this.ruleFeature6.opr('-D'));
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
      .set(NetworkProfile.getNetListIpsetName(m.getUniqueId()), 'src,src')
    const ruleEnable = ruleBase.clone().jmp(NTP_CHAIN_DNAT)
    const ruleDisable = ruleBase.clone().jmp('RETURN')

    const ruleBase6 = new Rule('nat').chn(NTP_CHAIN).fam(6)
      .set(NetworkProfile.getNetListIpsetName(m.getUniqueId()), 'src,src')
    const ruleEnable6 = ruleBase6.clone().jmp(NTP_CHAIN_DNAT)
    const ruleDisable6 = ruleBase6.clone().jmp('RETURN')

    if (setting == 1) { // positive
      await iptc.addRule(ruleEnable.opr('-I'));
      await iptc.addRule(ruleEnable6.opr('-I'));
      await iptc.addRule(ruleDisable.opr('-D'));
      await iptc.addRule(ruleDisable6.opr('-D'));
    } else if (setting == -1) { // negative
      await iptc.addRule(ruleEnable.opr('-D'));
      await iptc.addRule(ruleEnable6.opr('-D'));
      await iptc.addRule(ruleDisable.opr('-I'));
      await iptc.addRule(ruleDisable6.opr('-I'));
    } else if (setting == 0) { // neutral/reset
      await iptc.addRule(ruleEnable.opr('-D'));
      await iptc.addRule(ruleEnable6.opr('-D'));
      await iptc.addRule(ruleDisable.opr('-D'));
      await iptc.addRule(ruleDisable6.opr('-D'));
    }
  }

  async systemStart() {
    const rule = new Rule('nat').chn(NTP_CHAIN).jmp(NTP_CHAIN_DNAT)
    await iptc.addRule(rule);
    await iptc.addRule(rule.fam(6));
  }

  async systemStop() {
    const rule = new Rule('nat').chn(NTP_CHAIN).jmp(NTP_CHAIN_DNAT)
    await iptc.addRule(rule.opr('-D'));
    await iptc.addRule(rule.fam(6).opr('-D'));
  }

  // consider using iptables-restore/scripts if complexity goes up
  async globalOn() {
    await iptc.addRule(this.ruleFeature.opr('-A'));
    await iptc.addRule(this.ruleFeature6.opr('-A'));
    await iptc.addRule(this.ruleNtpOff.opr('-A'));
    await iptc.addRule(this.ruleNtpOff6.opr('-A'));
    await iptc.addRule(this.ruleLog.opr('-A'));
    await iptc.addRule(this.ruleLog6.opr('-A'));
    await iptc.addRule(this.ruleDNAT.opr('-A'));
    await iptc.addRule(this.ruleDNAT6.opr('-A'));

    // create temp ipset
    await ipset.create(`${ipset.CONSTANTS.IPSET_NTP_OFF}_TEMP`, 'list:set');
    await this.syncNtpOffSet();

    await super.globalOn()
    // start a quick check right away
    await this.job(1)
  }

  async globalOff() {
    await iptc.addRule(this.ruleFeature.opr('-D'));
    await iptc.addRule(this.ruleFeature6.opr('-D'));
    // no need to touch FW_PREROUTING_NTP_DNAT chain here

    if (this.adminSystemSwitch) {
      await ipset.destroy(`${ipset.CONSTANTS.IPSET_NTP_OFF}_TEMP`);
    }
    await super.globalOff()
  }
}

module.exports = NTPRedirectPlugin;
