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
let log = require('../net2/logger.js')(__filename);

let Sensor = require('./Sensor.js').Sensor;

let sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

let Samba = require('../extension/samba/samba.js');
let samba = new Samba();

let exec = require('child-process-promise').exec;

class DeviceNameUpdateSensor extends Sensor {

  constructor() {
    super();
    this.config.revalidationInterval = 3600 * 24; // every day
  }

  job() {
    return async(() => {
      let macEntries = await (hostTool.getAllMACEntries());
      let now = new Date() / 1000;
      let expireTime = now - this.config.revalidationInterval;
      macEntries.forEach((macEntry) => {
        if(!macEntry.bnameCheckTime || Number(macEntry.bnameCheckTime) < expireTime) {
          // need to check again
          let ip = macEntry.ipv4Addr;
          let name = await (samba.getSambaName(ip));
          if(name) {
            macEntry.bname = name;
          }
          macEntry.bnameCheckTime = now; // no matter whether there is a backup name, reset the timestamp after check
          await (hostTool.updateMACKey(macEntry, true)); // true means not updating the expire ttl for this mac Key
        }
      });
    })();
  }

  run() {
    setInterval(() => {
      this.job();
    }, 1000 * 60 * 60 * 24); // check samba every hour
  }
}

module.exports = DeviceNameUpdateSensor;
