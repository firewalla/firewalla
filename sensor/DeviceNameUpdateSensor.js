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
let log = require('../net2/logger.js')(__filename);

let Sensor = require('./Sensor.js').Sensor;

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

let Samba = require('../extension/samba/samba.js');
let samba = new Samba();

class DeviceNameUpdateSensor extends Sensor {

  constructor(config) {
    super(config);
    this.config.revalidationInterval = 3600 * 24; // every day
  }

  async job() {
    let macEntries = await hostTool.getAllMACEntries();
    let now = new Date() / 1000;
    let expireTime = now - this.config.revalidationInterval;
    for (const macEntry of macEntries) {
      if (!macEntry.bnameCheckTime || Number(macEntry.bnameCheckTime) < expireTime) {
        // need to check again
        let ip = macEntry.ipv4Addr;
        if (!ip) continue;
        let name = await samba.getSambaName(ip);
        if (name) {
          macEntry.bname = name;
        }
        macEntry.bnameCheckTime = now; // no matter whether there is a backup name, reset the timestamp after check
        await hostTool.updateMACKey(macEntry, true); // true means not updating the expire ttl for this mac Key
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
