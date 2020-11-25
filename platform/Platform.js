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

const log = require('../net2/logger.js')(__filename);
const f = require('../net2/Firewalla.js');
const fs = require('fs');
const Promise = require('bluebird');
const cp = require('child_process');
Promise.promisifyAll(fs);

const { exec } = require('child-process-promise');

class Platform {
  getAllNicNames() {
    // for red/blue, there is only one NIC
    return ["eth0"];
  }

  async getNicStates() {
    const nics = this.getAllNicNames();
    const result = {};
    for (const nic of nics) {
      const address = await fs.readFileAsync(`/sys/class/net/${nic}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch(() => "");
      const speed = await fs.readFileAsync(`/sys/class/net/${nic}/speed`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      const carrier = await fs.readFileAsync(`/sys/class/net/${nic}/carrier`, {encoding: 'utf8'}).then(result => result.trim()).catch(() => "");
      result[nic] = {address, speed, carrier};
    }
    return result;
  }

  getSignatureMac() {
    if (!this.signatureMac) {
      try {
        const mac = cp.execSync("cat /sys/class/net/eth0/address", {encoding: 'utf8'});
        this.signatureMac = mac && mac.trim().toUpperCase();
      } catch (err) {}
    }
    return this.signatureMac;
  }

  async getNetworkSpeed() {
    try {
      const output = await fs.readFileAsync(`/sys/class/net/${this.getAllNicNames[0]}/speed`, {encoding: 'utf8'});
      return output.trim();
    } catch(err) {
      log.debug('Error getting network speed', err)
      return null
    }
  }

  getDHKeySize() {
    return 1024;
  }

  getLedPaths() {
    return []
  }

  async turnOnPowerLED() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        const brightness = `${path}/brightness`;
        await exec(`sudo bash -c 'echo default-on > ${trigger}'`);
        await exec(`sudo bash -c 'echo 255 > ${brightness}'`);
      }
    } catch(err) {
      log.error("Error turning on LED", err)
    }
  }

  async turnOffPowerLED() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        await exec(`sudo bash -c 'echo none > ${trigger}'`);
        const brightness = `${path}/brightness`;
        await exec(`sudo bash -c 'echo 0 > ${brightness}'`);
      }
    } catch(err) {
      log.error("Error turning off LED", err)
    }
  }

  async blinkPowerLED() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        await exec(`sudo bash -c 'echo heartbeat > ${trigger}'`);
      }
    } catch(err) {
      log.error("Error blinking LED", err)
    }
  }

  async switchQoS(state, qdisc) {

  }

  getDNSServiceName() {
    return "firemasq";
  }

  getDHCPServiceName() {
    return "firemasq";
  }

  getVPNServerDefaultProtocol() {
    return "udp";
  }

  getName() {}

  getBoardSerial() {}

  getLicenseTypes() {}

  getSubnetCapacity() {}

  async getCpuTemperature() {}

  getPolicyCapacity() {}

  getAllowCustomizedProfiles(){}
  getRatelimitConfig(){}

  getDHCPCapacity() {
    return true
  }

  isFireRouterManaged() {
  }

  getCronTabFile() {
    return `${f.getFirewallaHome()}/etc/crontab`;
  }

  hasMultipleCPUs() {
    return false
  }

  isBonjourBroadcastEnabled() {
    return true;
  }

  defaultPassword() {
    return null;
  }

  isBluetoothAvailable() {
    return true
  }

  isOverlayNetworkAvailable() {
    return true;
  }

  getSystemResetAllOverlayfsScriptName() {
    return "system-reset-all-overlayfs.sh";
  }

  getRetentionTimeMultiplier() {
    return 1;
  }

  getRetentionCountMultiplier() {
    return 1;
  }

  isIFBSupported() {
    return false;
  }

  isDockerSupported() {
    return false;
  }

  isAccountingSupported() {
    return false;
  }  

  async onWanIPChanged(ip) {
    log.info("WanIP is changed to", ip);
  }

  async onVPNPortProtocolChanged() {
    log.info("VPN Port Protocol is changed");
  }

  async applyProfile() {
    log.info("NO need to apply profile");
  }
  getStatsSpecs(){
    return [];
  }
}

module.exports = Platform;
