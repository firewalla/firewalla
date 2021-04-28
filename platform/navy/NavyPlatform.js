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

class NavyPlatform extends Platform {

  getName() {
    return "navy";
  }

  getLicenseTypes() {
    return ["a3"];
  }

  getBoardSerial() {
    // use mac address as unique serial number
    return this.getSignatureMac();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.navy/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.navy/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 200;
  }

  getDHKeySize() {
    return 2048;
  }

  getLedPaths() {
    return [
      "/sys/devices/platform/gpio-leds/leds/status_led"
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
    if (state == true) {
      await exec(`sudo tc qdisc replace dev eth0 root ${qdisc}`).catch((err) => {
        log.error(`Failed to replace qdisc on eth0 with ${qdisc}`, err.message);
      });
    } else {
      await exec(`sudo tc qdisc del dev eth0 root`).catch((err) => {
        log.error(`Failed to remove qdisc on eth0`, err.message);
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
    return false;
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

  defaultPassword() {
    return "firewalla"
  }

  /*
  getSystemResetAllOverlayfsScriptName() {
    return "system-reset-all-overlayfs-navy.sh";
  }
  */

  getRetentionTimeMultiplier() {
    return 1;
  }

  getRetentionCountMultiplier() {
    return 1;
  }

  async onWanIPChanged(ip) {
    await super.onWanIPChanged(ip)

    // to refresh VPN filter in zeek
    await exec("sudo systemctl restart brofish");
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
}

module.exports = NavyPlatform;
