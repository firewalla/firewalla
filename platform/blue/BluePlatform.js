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

const fs = require('fs');
const util = require('util');
const readFileAsync = util.promisify(fs.readFile)

const cpuProfilePath = "/etc/default/cpufrequtils";

class BluePlatform extends Platform {

  getName() {
    return "blue";
  }

  getLicenseTypes() {
    return ["a2"];
  }

  getBoardSerial() {
    // use mac address as unique serial number
    return this.getSignatureMac();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.aarch64/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.aarch64/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 200;
  }

  getLedPaths() {
    return [
      // "/sys/devices/platform/leds/leds/nanopi:green:status",
      "/sys/devices/platform/leds/leds/nanopi:red:pwr"
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
    return false;
  }
  getAllowCustomizedProfiles(){
    return 1;
  }

  defaultPassword() {
    return "firewalla"
  }
}

module.exports = BluePlatform;
