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

const log = require('../net2/logger.js')(__filename);
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Sensor = require('./Sensor.js').Sensor;
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

class DeviceOfflineSensor extends Sensor {
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
    hostEntries.forEach(async (host) => {
      if (host) {
        let customizedOfflineIdle;
        let deviceOffline;
        const policy = await hostTool.loadDevicePolicyByMAC(host.mac);
        if (policy && policy["device_offline"]) {
          try {
            deviceOffline = JSON.parse(policy["device_offline"]);
          } catch (e) {
            log.error("Failed to parse device_offline value ", policy["device_offline"]);
          }
        }
        if (deviceOffline && deviceOffline.idle) {
          customizedOfflineIdle = deviceOffline.idle;
        } else {
          customizedOfflineIdle = this.idle;
        }
        if (!host.lastActiveTimestamp)
          return;
        const lastActiveTimestamp = Number(host.lastActiveTimestamp);
        const now = new Date() / 1000;
        const idleTime = now - lastActiveTimestamp;
        if (idleTime > customizedOfflineIdle && idleTime < customizedOfflineIdle + 2 * this.interval) {
          // ensure that device offline message will be emitted at most twice
          log.info(`Device ${host.mac} is offline, last seen at ${lastActiveTimestamp}.`);
          try {
            if (host.ipv6Addr && host.ipv6Addr.length > 0) {
              host.ipv6Addr = JSON.parse(host.ipv6Addr);
            }
          } catch (err) {}
          sem.emitEvent({
            type: "DeviceOffline",
            message: "A deivce was offline",
            host: host,
            lastSeen: lastActiveTimestamp
          });
        }
      }
    });
  }
}

module.exports = DeviceOfflineSensor;
