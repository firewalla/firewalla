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

let util = require('util');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let Sensor = require('./Sensor.js').Sensor;

class DHCPSensor extends Sensor {
  constructor() {
    super();
    this.cache = {};
  }
  
  run() {
    let DhcpDump = require("../extension/dhcpdump/dhcpdump.js");
    this.dhcpDump = new DhcpDump();
    this.dhcpDump.install((obj)=>{
      log.info("DHCPDUMP is installed");
      this.dhcpDump.start(false,(obj)=>{
        if (obj && obj.mac) {
          // dedup
          if(this.cache[obj.mac])
            return;          

          this.cache[obj.mac] = 1;
          setTimeout(() => {
            delete this.cache[obj.mac];
          }, 60 * 1000); // cache for one minute
          
          log.info(util.format("New Device Found: %s (%s)", obj.name, obj.mac));
          sem.emitEvent({
            type: "NewDeviceWithMacOnly",
            mac: obj.mac,
            name: obj.name,
            mtype: obj.mtype,
            from: 'dhcp',
            message: "may found a new device by dhcp"
          });
        }
      });
    });
  }
}

module.exports = DHCPSensor;

