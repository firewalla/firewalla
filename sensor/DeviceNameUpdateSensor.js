/*    Copyright 2016-2025 Firewalla Inc.
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
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager()
const Samba = require('../extension/samba/samba.js');
const samba = new Samba();

class DeviceNameUpdateSensor extends Sensor {

  constructor(config) {
    super(config);
    this.config.revalidationInterval = 3600 * 24; // every day
  }

  async job() {
    const hosts = await hostManager.getHostsFast()
    const now = Date.now() / 1000;
    const expireTime = now - this.config.revalidationInterval;
    for (const host of hosts) {
      if (!host.o.bnameCheckTime || Number(host.o.bnameCheckTime) < expireTime) {
        // need to check again
        const ip = host.o.ipv4Addr;
        if (!ip) continue;
        const name = await samba.getSambaName(ip);
        const update = {
          bnameCheckTime: now, // no matter whether there is a backup name, reset the timestamp after check
        }
        if (name) {
          update.sambaName = name;
        }
        await host.update(update, true, true)
      }
    }
  }

  run() {
    setInterval(() => {
      this.job();
    }, 1000 * 60 * 60 * 24); // check samba every hour
  }
}

module.exports = DeviceNameUpdateSensor;
