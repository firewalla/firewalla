/*    Copyright 2016-2022 Firewalla Inc.
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

const Platform = require('../Platform.js');
const f = require('../../net2/Firewalla.js');
const exec = require('child-process-promise').exec;
const log = require('../../net2/logger.js')(__filename);
const ipset = require('../../net2/Ipset.js');
const rp = require('request-promise');

const fs = require('fs');
const util = require('util');
const readFileAsync = util.promisify(fs.readFile);
const _ = require('lodash');

const firestatusBaseURL = "http://127.0.0.1:9966";

class PSEPlatform extends Platform {
  constructor() {
    super()
    this.__dirname = __dirname
  }

  getName() {
    return "pse";
  }

  getLicenseTypes() {
    return ["d1"];
  }

  // reserved wlan interfaces in case it supports USB wifi in future
  getAllNicNames() {
    return ["eth0", "eth1", "wlan0", "wlan1"];
  }

  getDNSServiceName() {
    return "firerouter_dns";
  }

  getDHCPServiceName() {
    return "firerouter_dhcp";
  }

  getBoardSerial() {
    // use mac address as unique serial number
    return this.getSignatureMac();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.purple/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.purple/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 200;
  }

  getDHKeySize() {
    return 2048;
  }

  getLedPaths() {
    return [
      "/sys/class/leds/sys_led/trigger"
    ];
  }

  async switchQoS(state, qdisc) {
    if (state == false) {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => {
        log.error(`Failed to add ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => {
        log.error(`Failed to add ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => {
        log.error(`Failed to remove ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => {
        log.error(`Failed to remove ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    }
    const supported = await exec(`modinfo sch_${qdisc}`).then(() => true).catch((err) => false);
    if (!supported) {
      log.error(`qdisc ${qdisc} is not supported`);
      return;
    }
    let options = "";
    if (qdisc === "cake")
      options = `${options} no-split-gso`;
    // replace the default root qdisc
    await exec(`sudo tc qdisc replace dev ifb0 parent 1:1 ${qdisc} ${options}`).catch((err) => {
      log.error(`Failed to update root qdisc on ifb0`, err.message);
    });
    await exec(`sudo tc qdisc replace dev ifb1 parent 1:1 ${qdisc} ${options}`).catch((err) => {
      log.error(`Failed to update root qdisc on ifb1`, err.message);
    });
  }

  getSubnetCapacity() {
    return 19;
  }

  // via /etc/update-motd.d/30-armbian-sysinfo
  async getCpuTemperature() {
    try {
      const source = '/sys/class/thermal/thermal_zone0/temp';
      return Number(await readFileAsync(source)) / 1000;
    } catch(err) {
      log.error("Failed to get cpu temperature, use 0 as default, err:", err);
      return 0;
    }
  }

  getDefaultWlanIntfName() {
    return 'wlan0';
  }

  getPolicyCapacity() {
    return 3000;
  }

  isTLSBlockSupport() {
    return true;
  }

  isFireRouterManaged() {
    return true;
  }

  isWireguardSupported() {
    return true;
  }

  getAllowCustomizedProfiles(){
    return 1;
  }
  getRatelimitConfig(){
    return {
      "appMax": 120,
      "webMax": 240,
      "duration": 60
    }
  }

  isBonjourBroadcastEnabled() {
    return false;
  }

  isOverlayNetworkAvailable() {
    return false;
  }

  isIFBSupported() {
    return true;
  }

  isDockerSupported() {
    return true;
  }

  getRetentionTimeMultiplier() {
    return 1;
  }

  getRetentionCountMultiplier() {
    return 1;
  }

  getCompresseCountMultiplier(){
    return 1;
  }

  getCompresseMemMultiplier(){
    return 1;
  }

  isAccountingSupported() {
    return true;
  }

  async applyProfile() {
    try {
      log.info("apply profile to optimize network performance");
      await exec(`sudo ${f.getFirewallaHome()}/scripts/apply_profile.sh`);
    } catch(err) {
      log.error("Error applying profile", err)
    }
  }
  getStatsSpecs() {
    return [{
      granularities: '1hour',
      hits: 72,
      stat: '3d'
    }]
  }

  async setLED(color, state) {
    const LED_PATH = '/sys/class/leds'
    const LED_TRIGGER_ERROR = `${LED_PATH}/red_led/trigger`;
    const LED_TRIGGER_STATUS = `${LED_PATH}/sys_led/trigger`;
    const LED_STATE_ON = 'default-on'
    const LED_STATE_OFF = 'none'
    const LED_STATE_BLINK = 'timer'
    try {
      log.info(`set LED ${color} to ${state}`);
      let triggerPath = null;
      switch (color) {
        case "error": {
          triggerPath = LED_TRIGGER_ERROR;
          break;
        }
        case "status": {
          triggerPath = LED_TRIGGER_STATUS;
          break;
        }
        default: {
          break;
        }
      }
      let triggerState = null;
      switch (state) {
        case "on": {
          triggerState = LED_STATE_ON;
          break;
        }
        case "off": {
          triggerState = LED_STATE_OFF;
          break;
        }
        case "blink": {
          triggerState = LED_STATE_BLINK;
          break;
        }
        default: {
          break;
        }
      }
      if ( triggerPath && triggerState ) {
        log.debug(`set ${triggerPath} to ${triggerState}`);
        await exec(`echo "${triggerState}" | sudo tee ${triggerPath}`);
      }
    } catch (err) {
      log.error(`Failed to set LED ${color} to ${state}:`,err);
    }
  }

  async configLED(policy) {
    log.info("Apply LED configuration: ",policy);
    if ( 'mode' in policy ) {
      switch ( policy.mode ) {
        case "on"  : {
          log.info("Turn ON status LED.");
          await this.setLED("status","off");
          break;
        }
        case "off"  : {
          log.info("Turn OFF status LED.");
          await this.setLED("status","on");
          break;
        }
        case "auto" : {
          log.info("Status LED is automatically controlled by Firewalla");
          break;
        }
      }

    } else {
      log.error("Invalid policy with NO mode defined.");
    }
  }

  async updateLEDDisplay(systemState) {
    log.info("Update LED display based on system state");

    const SYSTEM_CHECKS = [ 'fireboot', 'firereset', 'firerouter' ];
    const NETWORK_CHECKS = [ 'fireboot_network', 'wan', 'firerouter_network'];

    let systemError = false;
    for (const comp of SYSTEM_CHECKS) {
      if (comp in systemState && systemState[comp] === 'fail') {
        systemError = true;
      }
    }
    let networkError = false;
    for (const comp of NETWORK_CHECKS) {
      if (comp in systemState && systemState[comp] === 'fail') {
        networkError = true;
      }
    }

    if (networkError) {
      await this.setLED("error", "blink")
    } else if (systemError) {
      await this.setLED("error", "on")
    } else {
      await this.setLED("error", "off")
    }

    switch (systemState.boot_state) {
      case "booting": {
        await this.setLED("status","blink");
        break;
      }
      case "ready4pairing": {
        await this.setLED("status","on");
        break;
      }
      case "paired": {
        await this.setLED("status","off");
        break;
      }
    }
  }

  async ledReadyForPairing() {
    await rp(`${firestatusBaseURL}/fire?name=firekick&type=ready_for_pairing`).catch((err) => {
      log.error("Failed to set LED as ready for pairing, err:", err.message);
    });
  }

  async ledPaired() {
    await rp(`${firestatusBaseURL}/resolve?name=firekick&type=ready_for_pairing`).catch((err) => {
      log.error("Failed to set LED as paired, err:", err.message);
    });
  }

  async ledSaving() {
    await rp(`${firestatusBaseURL}/fire?name=nodejs&type=writing_disk`).catch((err) => {
      log.error("Failed to set LED as saving, err:", err.message);
    });
  }

  async ledDoneSaving() {
    await rp(`${firestatusBaseURL}/resolve?name=nodejs&type=writing_disk`).catch((err) => {
      log.error("Failed to set LED as done saving, err:", err.message);
    });
  }

  async ledStartResetting() {
    await rp(`${firestatusBaseURL}/fire?name=nodejs&type=reset`).catch((err) => {
      log.error("Failed to set LED as resetting, err:", err.message);
    });
  }

  async ledNetworkDown() {
    await rp(`${firestatusBaseURL}/fire?name=nodejs&type=network_down`).catch((err) => {
      log.error("Failed to set LED as network down, err:", err.message);
    });
  }

  async ledNetworkUp() {
    await rp(`${firestatusBaseURL}/resolve?name=nodejs&type=network_down`).catch((err) => {
      log.error("Failed to set LED as network up, err:", err.message);
    });
  }

  async ledBooting() {
    try {
      this.updateLEDDisplay({boot_state:"booting"});
    } catch(err) {
      log.error("Error set LED as booting", err)
    }
  }

  getSpeedtestCliBinPath() {
    return `${f.getRuntimeInfoFolder()}/assets/speedtest`
  }

  getSSHPasswdFilePath() {
    // this directory will be flushed over the reboot, which is consistent with /etc/passwd in root partition
    return `/dev/shm/.sshpassword`;
  }

  hasDefaultSSHPassword() {
    return false;
  }

  openvpnFolder() {
    return "/home/pi/openvpn";
  }

  getDnsmasqLeaseFilePath() {
    return `${f.getFireRouterRuntimeInfoFolder()}/dhcp/dnsmasq.leases`;
  }
}

module.exports = PSEPlatform;
