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
const util = require('util');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Sensor = require('./Sensor.js').Sensor;
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

class DeviceOfflineSensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    this.interval = 60; // interval default to 60 seconds
    if (this.config && this.config.interval) {
      this.interval = this.config.interval;
    }
    this.idle = 1800; // idle time default to 30 minutes
    if (this.config && this.config.idle) {
      this.idle = this.config.idle;
    }
    setInterval(() => {
      this.checkDeviceActivity();
    }, this.interval * 1000); // every minute
  }

  async checkDeviceActivity() {

    log.debug("Start to check device activity...");
    const hostEntries = await hostTool.getAllMACEntries();
    hostEntries.forEach((host) => {
      const lastActiveTimestamp = Number(host.lastActiveTimestamp);
      const now = new Date() / 1000;
      const idleTime = now - lastActiveTimestamp;
      if (idleTime > this.idle && idleTime < this.idle + 2 * this.interval) {
        // ensure that device offline message will be emitted at most twice
        log.info(`Device ${host.mac} is offline, last seen at ${lastActiveTimestamp}.`);
        sem.emitEvent({
          type: "DeviceOffline",
          message: "A deivce was offline",
          host: host,
          lastSeen: lastActiveTimestamp
        });
      }
    });
  }
}

module.exports = DeviceOfflineSensor;