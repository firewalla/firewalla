/*    Copyright 2016-2021 Firewalla Inc.
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
const utils = require('../../lib/utils.js');
const log = require('../../net2/logger.js')(__filename);
const fs = require('fs');
const util = require('util');
const readFileAsync = util.promisify(fs.readFile)

class RedPlatform extends Platform {

  getName() {
    return "red";
  }

  getLicenseTypes() {
    return ["a0", "a1"];
  }

  getBoardSerial() {
    return utils.getCpuId();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.armv7l/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.armv7l/bitbridge6`;
  }

  getGCMemoryForMain() {
    return 100;
  }

  getLedPaths() {
    return [
      "/sys/devices/platform/leds/leds/nanopi:green:pwr",
      "/sys/devices/platform/leds/leds/nanopi:blue:status"
    ];
  }

  getBroProcName() {
    return "bro";
  }

  async applyCPUDefaultProfile() {
    return; // do nothing for red
  }

  async applyCPUBoostProfile() {
    return; // do nothing for red
  }

  getSubnetCapacity() {
    return 24;
  }

  // via /etc/update-motd.d/30-sysinfo
  async getCpuTemperature() {
    try {
      const source = '/sys/devices/virtual/thermal/thermal_zone0/temp';
      return Number(await readFileAsync(source)) / 1000;
    } catch(err) {
      log.error("Failed to get cpu temperature, use 0 as default, err:", err);
      return 0;
    }
  }

  getPolicyCapacity() {
    return 1000;
  }

  isFireRouterManaged() {
    return false;
  }

  getAllowCustomizedProfiles(){
    return 0;
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

  isBluetoothAvailable() {
    return false
  }

  isEventsSupported() {
    return false;
  }

  isAuditLogSupported() {
    return false;
  }

  getDnsmasqBinaryPath() {
    return `${__dirname}/files/dnsmasq`;
  }

  getDnsproxySOPath() {
    return `${__dirname}/files/libdnsproxy.so`
  }

  getSpeedtestCliBinPath() {
    return `${__dirname}/files/speedtest`
  }

  supportSSHInNmap() {
    return false;
  }
}

module.exports = RedPlatform;
