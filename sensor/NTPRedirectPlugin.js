/*    Copyright 2023 Firewalla Inc.
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
const DNAT_JUMP = 'DNAT --to-destination 127.0.0.1'
const DNAT_JUMP_6 = 'DNAT --to-destination ::1'

class NTPRedirectPlugin extends MonitorablePolicyPlugin {
  constructor(config) {
    super(config)

    this.refreshInterval = (this.config.refreshInterval || 60) * 1000;

    this.ruleFeature = new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').mth(123, null, 'dport').jmp(NTP_CHAIN)
    this.ruleFeature6 = this.ruleFeature.clone().fam(6)

    this.localServerStatus = true
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

    const ruleBase = new Rule('nat').chn(NTP_CHAIN)
      .mdl('set', `--match-set ${NetworkProfile.getNetIpsetName(m.getUniqueId())} src,src`)
    const ruleDNAT = ruleBase.clone().jmp(DNAT_JUMP)
    const ruleReturn = ruleBase.clone().jmp('RETURN')

    const ruleBase6 = new Rule('nat').chn(NTP_CHAIN).fam(6)
      .mdl('set', `--match-set ${NetworkProfile.getNetIpsetName(m.getUniqueId(), 6)} src,src`)
    const ruleDNAT6 = ruleBase6.clone().jmp(DNAT_JUMP_6)
    const ruleReturn6 = ruleBase6.clone().jmp('RETURN')

    if (setting == 1) { // positive
      await ruleDNAT.exec('-I')
      await ruleDNAT6.exec('-I')
      await ruleReturn.exec('-D')
      await ruleReturn6.exec('-D')
    } else if (setting == -1) { // negative
      await ruleDNAT.exec('-D')
      await ruleDNAT6.exec('-D')
      await ruleReturn.exec('-I')
      await ruleReturn6.exec('-I')
    } else if (setting == 0) { // neutral/reset
      await ruleDNAT.exec('-D')
      await ruleDNAT6.exec('-D')
      await ruleReturn.exec('-D')
      await ruleReturn6.exec('-D')
    }
  }

  async systemStart() {
    const rule = new Rule('nat').chn(NTP_CHAIN)
    await rule.jmp(DNAT_JUMP).exec('-A')
    await rule.fam('6').jmp(DNAT_JUMP_6).exec('-A')
  }

  async systemStop() {
    const rule = new Rule('nat').chn(NTP_CHAIN)
    await rule.jmp(DNAT_JUMP).exec('-D')
    await rule.fam('6').jmp(DNAT_JUMP_6).exec('-D')
  }

  // consider using iptables-restore/scripts if complexity goes up
  async globalOn() {
    await new Rule('nat').chn(NTP_CHAIN).exec('-N')
    await new Rule('nat').chn(NTP_CHAIN).fam(6).exec('-N')
    await this.ruleFeature.exec('-A')
    await this.ruleFeature6.exec('-A')

    await super.globalOn()
    // start a quick check right away
    await this.job(1)
  }

  async globalOff() {
    await this.ruleFeature.exec('-D')
    await this.ruleFeature6.exec('-D')

    await super.globalOff()
  }
}

module.exports = NTPRedirectPlugin;
