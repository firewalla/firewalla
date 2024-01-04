/*    Copyright 2023-2024 Firewalla Inc.
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


const PREROUTING_CHAIN = 'FW_PREROUTING'
const NTP_CHAIN = 'FW_PREROUTING_NTP'
const NTP_CHAIN_DNAT = 'FW_PREROUTING_NTP_DNAT'

class NTPRedirectPlugin extends MonitorablePolicyPlugin {
  constructor(config) {
    super(config)

    this.refreshInterval = (this.config.refreshInterval || 60) * 1000;

    // only request is DNATed
    this.ruleFeature = new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').dport(123)
      .set('monitored_net_set', 'src,src').set('acl_off_set', 'src,src', true).jmp(NTP_CHAIN)
    this.ruleFeature6 = this.ruleFeature.clone().fam(6)

    // TODO: local NTP traffic is not distinguished here
    this.ruleLog = new Rule('nat').chn(NTP_CHAIN_DNAT).mdl('conntrack', '--ctstate NEW --ctdir ORIGINAL')
      .log(Constant.IPTABLES_LOG_PREFIX_AUDIT + 'A=RD D=O ')
    this.ruleLog6 = this.ruleLog.clone().fam(6)
    this.ruleDNAT = new Rule('nat').chn(NTP_CHAIN_DNAT).jmp(`DNAT --to-destination 127.0.0.1`)
    this.ruleDNAT6 = new Rule('nat').chn(NTP_CHAIN_DNAT).fam(6).jmp(`DNAT --to-destination ::1`)

    this.localServerStatus = true

    execAsync(String.raw`sudo sed -i -E 's/(^restrict .*)limited(.*$)/\1\2/' /etc/ntp.conf; sudo systemctl restart ntp`).catch(()=>{})
  }

  async job(retry = 5) {
    super.job()

    if (!fc.isFeatureOn(this.config.featureName)) return

    while (retry--)
      try {
        await execAsync('ntpdate -q localhost')
        if (!this.localServerStatus)
          log.info('NTP is back online on localhost')
        await this.ruleFeature.exec('-A')
        await this.ruleFeature6.exec('-A')
        await rclient.setAsync(Constant.REDIS_KEY_NTP_SERVER_STATUS, 1)
        this.localServerStatus = true
        return
      } catch(err) {
        (this.localServerStatus ? log.warn : log.verbose)('NTP not available on localhost, retries left', retry)
        log.debug(err.message)
      }

    if (this.localServerStatus)
      log.error('Local NTP down, removing redirection')
    await this.ruleFeature.exec('-D')
    await this.ruleFeature6.exec('-D')
    await rclient.setAsync(Constant.REDIS_KEY_NTP_SERVER_STATUS, 0)
    this.localServerStatus = false
  }

  async applyMonitorable(m, setting) {
    if (!(m instanceof NetworkProfile)) {
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
      await ruleEnable.exec('-I')
      await ruleEnable6.exec('-I')
      await ruleDisable.exec('-D')
      await ruleDisable6.exec('-D')
    } else if (setting == -1) { // negative
      await ruleEnable.exec('-D')
      await ruleEnable6.exec('-D')
      await ruleDisable.exec('-I')
      await ruleDisable6.exec('-I')
    } else if (setting == 0) { // neutral/reset
      await ruleEnable.exec('-D')
      await ruleEnable6.exec('-D')
      await ruleDisable.exec('-D')
      await ruleDisable6.exec('-D')
    }
  }

  async systemStart() {
    const rule = new Rule('nat').chn(NTP_CHAIN).jmp(NTP_CHAIN_DNAT)
    await rule.exec('-A')
    await rule.fam('6').exec('-A')
  }

  async systemStop() {
    const rule = new Rule('nat').chn(NTP_CHAIN).jmp(NTP_CHAIN_DNAT)
    await rule.exec('-D')
    await rule.fam('6').exec('-D')
  }

  // consider using iptables-restore/scripts if complexity goes up
  async globalOn() {
    await new Rule('nat').chn(NTP_CHAIN).exec('-N')
    await new Rule('nat').chn(NTP_CHAIN).fam(6).exec('-N')
    await new Rule('nat').chn(NTP_CHAIN_DNAT).exec('-N')
    await new Rule('nat').chn(NTP_CHAIN_DNAT).fam(6).exec('-N')
    await this.ruleFeature.exec('-A')
    await this.ruleFeature6.exec('-A')
    await this.ruleLog.exec('-A')
    await this.ruleLog6.exec('-A')
    await this.ruleDNAT.exec('-A')
    await this.ruleDNAT6.exec('-A')

    await super.globalOn()
    // start a quick check right away
    await this.job(1)
  }

  async globalOff() {
    await this.ruleFeature.exec('-D')
    await this.ruleFeature6.exec('-D')
    // no need to touch FW_PREROUTING_NTP_DNAT chain here

    await super.globalOff()
  }
}

module.exports = NTPRedirectPlugin;
