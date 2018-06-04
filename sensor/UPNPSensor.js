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

let natUpnp = require('../extension/upnp/nat-upnp');

class UPNPSensor extends Sensor {
  constructor() {
    super();
    this.upnpClient = natUpnp.createClient();
  }

  run() {
    setInterval(() => {
      this.upnpClient.getMappings((err, results) => {
        if (results && results.length >= 0) {
          let key = "sys:scan:nat";
          rclient.hmset(key, {
            upnp: JSON.stringify(results)
          }, (err, data) => {
            if(err) {
              log.error("Failed to update upnp mapping in database: " + err, {});
              return;
            }
            log.info("UPNP mapping is updated,", results.length, "entries", {});
          });
        } else {
          log.info("No upnp mapping found in network");
        }
      });
    }, 60 * 10 * 1000); // check every 10 minutes
  }
}

module.exports = UPNPSensor;
