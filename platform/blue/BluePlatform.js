/*    Copyright 2016 Firewalla LLC 
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
const fConfig = require('../../net2/config.js').getConfig();
const exec = require('child-process-promise').exec;

const ledPaths = [
//  "/sys/devices/platform/leds/leds/nanopi:green:status",
  "/sys/devices/platform/leds/leds/nanopi:red:pwr"
];

class BluePlatform extends Platform {

  getName() {
    return "blue";
  }

  getLicenseTypes() {
    return ["a2"];
  }

  getBoardSerial() {
    // use mac address as unique serial number
    if(fConfig.monitoringInterface) {
      const interfaces = require('os').networkInterfaces();
      if(interfaces && interfaces[fConfig.monitoringInterface] && interfaces[fConfig.monitoringInterface].length > 0) {
        return interfaces[fConfig.monitoringInterface][0].mac;
      }
    }
    return new Date() / 1;
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

  turnOnPowerLED() {
    ledPaths.forEach(async (path) => {
      const trigger = `${path}/trigger`;
      const brightness = `${path}/brightness`;
      await exec(`sudo bash -c 'echo none > ${trigger}'`);
      await exec(`sudo bash -c 'echo 255 > ${brightness}'`);
    });
  }

  turnOffPowerLED() {
    ledPaths.forEach(async (path) => {
      const trigger = `${path}/trigger`;
      await exec(`sudo bash -c 'echo none > ${trigger}'`);
      const brightness = `${path}/brightness`;
      await exec(`sudo bash -c 'echo 0 > ${brightness}'`);
    });
  }

  blinkPowerLED() {
    ledPaths.forEach(async (path) => {
      const trigger = `${path}/trigger`;
      await exec(`sudo bash -c 'echo heartbeat > ${trigger}'`);
    });
  }
}

module.exports = BluePlatform;
