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
const fc = require('../net2/config.js')
const MonitorablePolicyPlugin = require('./MonitorablePolicyPlugin.js')
const NetworkProfile = require('../net2/NetworkProfile.js')
const { Rule } = require('../net2/Iptables.js');

const execAsync = require('child-process-promise').exec


const PREROUTING_CHAIN = 'FW_PREROUTING'
const NTP_CHAIN = 'FW_PREROUTING_NTP'
const DNAT_JUMP = 'DNAT --to-destination 127.0.0.1'

class NTPRedirectPlugin extends MonitorablePolicyPlugin {
  constructor(config) {
    super(config)

    this.refreshInterval = (this.config.refreshInterval || 60) * 1000;
  }

  async job() {
    if (!fc.isFeatureOn(this.config.featureName)) return

    let retry = 5
    while (retry--)
      try {
        await execAsync('ntpdate -q localhost')
        await new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').mth(123, null, 'dport').jmp(NTP_CHAIN).exec('-A')
        return
      } catch(err) {
        log.warn('NTP not available on localhost, retries left', retry)
      }

    log.error('Local NTP down, removing redirection')
    await new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').mth(123, null, 'dport').jmp(NTP_CHAIN).exec('-D')
  }

  async applyMonitorable(m, setting) {
    if (!m instanceof NetworkProfile) {
      log.warn(`Policy on ${m.constructor.getClassName()}:${m.getGUID()} not supported`)
      return
    }

    const ruleBase = new Rule('nat').chn(NTP_CHAIN)
      .mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(m.getUniqueId())} src,src`)
    const ruleDNAT = ruleBase.clone().jmp(DNAT_JUMP)
    const ruleReturn = ruleBase.clone().jmp('RETURN')

    if (setting == 1) { // positive
      await ruleDNAT.exec('-I')
      await ruleReturn.exec('-D')
    } else if (setting == -1) { // negative
      await ruleDNAT.exec('-D')
      await ruleReturn.exec('-I')
    } else if (setting == 0) { // neutral/reset
      await ruleDNAT.exec('-D')
      await ruleReturn.exec('-D')
    }
  }

  async systemStart() {
    await new Rule('nat').chn(NTP_CHAIN).jmp(DNAT_JUMP).exec('-A')
  }

  async systemStop() {
    await new Rule('nat').chn(NTP_CHAIN).jmp(DNAT_JUMP).exec('-D')
  }

  // consider using iptables-restore/scripts if complexity goes up
  async globalOn() {
    await new Rule('nat').chn(NTP_CHAIN).exec('-N')
    await new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').mth(123, null, 'dport').jmp(NTP_CHAIN).exec('-A')

    await super.globalOn()
  }

  async globalOff() {
    await new Rule('nat').chn(PREROUTING_CHAIN).pro('udp').mth(123, null, 'dport').jmp(NTP_CHAIN).exec('-D')

    await super.globalOff()
  }
}

module.exports = NTPRedirectPlugin;
