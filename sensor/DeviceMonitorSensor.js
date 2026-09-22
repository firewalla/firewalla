/*    Copyright 2016-2026 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')

const fwapc = require('../net2/fwapc.js');

const FEATURE_DEVICE_MONITOR = "device_monitor";

class DeviceMonitorSensor extends Sensor {

  constructor(config) {
    super(config)
    this.adminSwitch = false;
  }

  async globalOn() {
    log.info("run globalOn ...");
    this.adminSwitch = true;
  }

  async globalOff() {
    log.info("run globalOff ...");
    this.adminSwitch = false;
  }

  async run() {

    log.info("run Device Monitor Sensor ...");

    this.hookFeature(FEATURE_DEVICE_MONITOR);
  }

  async apiRun(){
    extensionManager.onGet("deviceMonitorData", async (msg,data) => {
    });

    extensionManager.onGet("staStatus", async (msg,data) => {
      try {
        const mac = data && data.mac;
        const status = await fwapc.getSTAStatus(mac)
        return status;
      } catch(err) {
        log.error('Error getting staStatus', err.message)
        return null
      }
    });
  }

}

module.exports = DeviceMonitorSensor;
