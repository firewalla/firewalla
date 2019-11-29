/*    Copyright 2019 Firewalla INC
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

 const pclient = require('../util/redis_manager').getPublishClient();
 const SysManager = require('../net2/SysManager.js');
 const sysManager = new SysManager();
 const networkTool = require('../net2/NetworkTool.js')();
 const Discovery = require('../net2/Discovery.js');
 const d = new Discovery();

 class IPChangeSensor extends Sensor {
   constructor() {
     super();
   }

   async job() {
    const interfaces = await networkTool.listInterfaces();
    for (let i in interfaces) {
      const intf = interfaces[i];
      if (intf.type === "Wired" && intf.name === "eth0") {
        const ipv4Address = intf.ip_address;
        // TODO: support ipv6 address change detection
        // const ipv6Addresses = intf.ip6_addresses || [];
        const currentIpv4Addr = sysManager.myIp();
        if (ipv4Address !== currentIpv4Addr) {
          d.discoverInterfaces((err, list) => {
            if (!err) {
              sysManager.update((err) => {
                if (err) {
                  log.error("Failed to update IP in sysManager", err);
                } else {
                  pclient.publishAsync("System:IPChange", "");
                }
              });
            } else {
              log.error("Failed to discover interfaces", err);
            }
          })
        } else {
          log.info("IP address of eth0 is not changed: " + ipv4Address);
        }
        return; // do not publish additional ip change if eth0 has multiple ip addresses
      }
    }
   }

   run() {
     setInterval(() => {
       this.job();
     }, 300 * 1000); // check ip change once every 5 minutes
   }
 }

 module.exports = IPChangeSensor;