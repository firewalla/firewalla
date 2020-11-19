/*    Copyright 2019 Firewalla Inc.
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
const fs = require('fs').promises; // available after Node 10
const log = require('../../net2/logger.js')(__filename);
const iptables = require('../../net2/Iptables.js');

const cpuProfilePath = "/etc/default/cpufrequtils";

class GoldPlatform extends Platform {

  getName() {
    return "gold";
  }

  getLicenseTypes() {
    return ["b1"];
  }

  getAllNicNames() {
    // there are for NICs on gold
    return ["eth0", "eth1", "eth2", "eth3"];
  }

  getDHCPServiceName() {
    return "firerouter_dhcp";
  }

  getDNSServiceName() {
    return "firerouter_dns";
  }

  getBoardSerial() {
    // use mac address as unique serial number
    return this.getSignatureMac();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.x86_64/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.x86_64/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 200;
  }

  getLedPaths() {
    return [
      // "/sys/devices/platform/leds/leds/nanopi:green:status",
//      "/sys/devices/platform/leds/leds/nanopi:red:pwr"
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
      await iptables.switchQoSAsync(false);
      await iptables.switchQoSAsync(false, 6);
    } else {
      await iptables.switchQoSAsync(true);
      await iptables.switchQoSAsync(true, 6);
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
    return 18;
  }

  hasMultipleCPUs() {
    return true
  }

  async getCpuTemperature() {
    try {
      const path = '/sys/class/hwmon/hwmon1/'
      const tempList = []
      const dir = await fs.opendir(path)
      for await (const dirent of dir) {
        if (dirent.name.match(/temp(\d+)_input/)) {
          const input = await fs.readFile(path + dirent.name, 'utf8')
          tempList.push(Number(input) / 1000)
        }
      }
      return tempList
    } catch(err) {
      log.error("Failed to get cpu temperature, use 0 as default, err:", err);
      return 0;
    }
  }

  getPolicyCapacity() {
    return 3000;
  }

  getDHCPCapacity() {
    return false
  }

  isFireRouterManaged() {
    return true;
  }

  getCronTabFile() {
    return `${f.getFirewallaHome()}/etc/crontab.gold`;
  }
  getAllowCustomizedProfiles(){
    return 10;
  }
  getRatelimitConfig(){
    return {
      "appMax": 240,
      "webMax": 480,
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
  getStatsSpecs() {
    return [{
      granularities: '1hour',
      hits: 72,
      stat: '3d'
    }]
  }
}

module.exports = GoldPlatform;
