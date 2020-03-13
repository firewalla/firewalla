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
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const log = require('../../net2/logger.js')(__filename);

const cpuProfilePath = "/etc/default/cpufrequtils";

class GoldPlatform extends Platform {

  getName() {
    return "gold";
  }

  getLicenseTypes() {
    return ["b1"];
  }

  async getNicStates() {
    // get all nics on gold
    const nics = ["eth0", "eth1", "eth2", "eth3"];
    const result = {};
    for (const nic of nics) {
      const address = await fs.readFileAsync(`/sys/class/net/${nic}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch((err) => "");
      const speed = await fs.readFileAsync(`/sys/class/net/${nic}/speed`, {encoding: 'utf8'}).then(result => result.trim()).catch((err) => "");
      const carrier = await fs.readFileAsync(`/sys/class/net/${nic}/carrier`, {encoding: 'utf8'}).then(result => result.trim()).catch((err) => "");
      result[nic] = {address, speed, carrier};
    }
    return result;
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

  // via /etc/update-motd.d/30-armbian-sysinfo
  getCpuTemperature() {
//    const source = '/etc/armbianmonitor/datasources/soctemp';
//    return Number(fs.readFileSync(source)) / 1000;
    return 30;
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

  getBroTabFile() {
    return `${f.getFirewallaHome()}/etc/brotab.gold`;
  }
}

module.exports = GoldPlatform;
