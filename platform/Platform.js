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

const log = require('../net2/logger.js')(__filename);
const fConfig = require('../net2/config.js').getConfig();
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const { exec } = require('child-process-promise');

class Platform {
  async getNetworkSpeed() {
    const output = await fs.readFileAsync(`/sys/class/net/${fConfig.monitoringInterface}/speed`, {encoding: 'utf8'});
    return output.trim();
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
      };
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
      };
    } catch(err) {
      log.error("Error turning off LED", err)
    }
  }

  async blinkPowerLED() {
    try {
      for (const path of this.getLedPaths()) {
        const trigger = `${path}/trigger`;
        await exec(`sudo bash -c 'echo heartbeat > ${trigger}'`);
      };
    } catch(err) {
      log.error("Error blinking LED", err)
    }
  }
}

module.exports = Platform;
