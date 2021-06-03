/*    Copyright 2016-2020 Firewalla Inc.
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
const f = require('../../net2/Firewalla.js')
const exec = require('child-process-promise').exec;
const log = require('../../net2/logger.js')(__filename);
const ipset = require('../../net2/Ipset.js');

const fs = require('fs');
const util = require('util');
const readFileAsync = util.promisify(fs.readFile)

const cpuProfilePath = "/etc/default/cpufrequtils";

class PurplePlatform extends Platform {

  getName() {
    return "purple";
  }

  getLicenseTypes() {
    return ["c1"];
  }

  getAllNicNames() {
    // there are two NICs on purple
    return ["eth0", "eth1"];
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
      "/sys/class/leds/red_led"
    ];
  }

  async turnOnPowerLED() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        const brightness = `${path}/brightness`;
        await exec(`sudo bash -c 'echo none > ${trigger}'`);
        await exec(`sudo bash -c 'echo 255 > ${brightness}'`);
      }
    } catch(err) {
      log.error("Error turning on LED", err)
    }
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
  }

  getCPUDefaultFile() {
    return `${__dirname}/files/cpu_default.conf`;
  }

  async applyCPUDefaultProfile() {
    log.info("Applying CPU default profile...");
    const cmd = `sudo cp ${this.getCPUDefaultFile()} ${cpuProfilePath}`;
    await exec(cmd);
    return this.reload();
  }

  async reload() {
    return exec("sudo systemctl reload cpufrequtils");
  }

  getCPUBoostFile() {
    return `${__dirname}/files/cpu_boost.conf`;
  }

  async applyCPUBoostProfile() {
    log.info("Applying CPU boost profile...");
    const cmd = `sudo cp ${this.getCPUBoostFile()} ${cpuProfilePath}`;
    await exec(cmd);
    return this.reload();
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

  getPolicyCapacity() {
    return 3000;
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

  getRetentionTimeMultiplier() {
    return 1;
  }

  getRetentionCountMultiplier() {
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

  async configFan(policy) {
    const FAN_MODE_PATH='/sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1_enable';
    const FAN_SPEED_PATH='/sys/devices/platform/pwm-fan/hwmon/hwmon0/pwm1';
    const FAN_MODE_MANUAL=1;
    const FAN_MODE_AUTO=2;
    const FAN_SPEED_MIN=0;
    const FAN_SPEED_MAX=255;
    try {
      log.info("config fan with policy: ",policy);

      log.info("set fan mode: ",policy.mode);
      switch (policy.mode) {
        case "auto" : {
          await exec(`echo ${FAN_MODE_AUTO} | sudo tee ${FAN_MODE_PATH}`);
          break;
        }
        case "manual" : {
          await exec(`echo ${FAN_MODE_MANUAL} | sudo tee ${FAN_MODE_PATH}`);
          break;
        }
        default: {
          log.error("unsupported fan mode: ",policy.mode)
        }
      }

      if ( 'speed' in policy ) {
        let fanSpeed = policy.speed;
        if ( fanSpeed>=FAN_SPEED_MIN && fanSpeed<=FAN_SPEED_MAX ) {
          log.info("set fan speed:",fanSpeed);
          await exec(`echo ${fanSpeed} | sudo tee ${FAN_SPEED_PATH}`);
        } else {
          log.error("Invalid fan speed value(beyond [0,255]):",fanSpeed);
        }
      }
    } catch(err) {
      log.error("Error config fan", err)
    }
  }
}

module.exports = PurplePlatform;
