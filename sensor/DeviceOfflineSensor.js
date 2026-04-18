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
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

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

  checkDeviceActivity() {
    log.debug("Start to check device activity...");
    const hosts = hostManager.getActiveHosts();
    for (const host of hosts) {
      const o = host.o;
      if (!o) continue;

      // getPolicyFast reads the in-memory host.policy (loaded at construction,
      // kept in sync via messageBus); values are already JSON-parsed — no Redis call
      const deviceOffline = host.getPolicyFast("device_offline");
      const customizedOfflineIdle = (deviceOffline && deviceOffline.idle) ? deviceOffline.idle : this.idle;

      if (!o.lastActiveTimestamp) continue;

      const lastActiveTimestamp = Number(o.lastActiveTimestamp);
      const now = Date.now() / 1000;
      const idleTime = now - lastActiveTimestamp;

      if (idleTime > customizedOfflineIdle && idleTime < customizedOfflineIdle + 2 * this.interval) {
        // ensure that device offline message will be emitted at most twice
        log.info(`Device ${o.mac} is offline, last seen at ${lastActiveTimestamp}`);
        const hostData = Object.assign({}, o);
        try {
          if (hostData.ipv6Addr && hostData.ipv6Addr.length > 0) {
            hostData.ipv6Addr = JSON.parse(hostData.ipv6Addr);
          }
        } catch (err) {}
        sem.emitEvent({
          type: "DeviceOffline",
          message: "A deivce was offline",
          host: hostData,
          lastSeen: lastActiveTimestamp
        });
      }
    }
  }
}

module.exports = DeviceOfflineSensor;
