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
const fConfig = require('../net2/config.js').getConfig();
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
      const address = await fs.readFileAsync(`/sys/class/net/${nic}/address`, {encoding: 'utf8'}).then(result => result.trim().toUpperCase()).catch((err) => "");
      const speed = await fs.readFileAsync(`/sys/class/net/${nic}/speed`, {encoding: 'utf8'}).then(result => result.trim()).catch((err) => "");
      const carrier = await fs.readFileAsync(`/sys/class/net/${nic}/carrier`, {encoding: 'utf8'}).then(result => result.trim()).catch((err) => "");
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
      const output = await fs.readFileAsync(`/sys/class/net/${fConfig.monitoringInterface}/speed`, {encoding: 'utf8'});
      return output.trim();
    } catch(err) {
      log.debug('Error getting network speed', err)
      return null
    }
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

  getDHCPCapacity() {
    return true
  }

  isFireRouterManaged() {
  }

  getBroTabFile() {
    return `${f.getFirewallaHome()}/etc/brotab`;
  }

  hasMultipleCPUs() {
    return false
  }

  isBonjourBroadcastEnabled() {
    return true;
  }

}

module.exports = Platform;
