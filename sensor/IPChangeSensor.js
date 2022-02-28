/*    Copyright 2019-2022 Firewalla Inc.
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

 const sysManager = require('../net2/SysManager.js');
 const networkTool = require('../net2/NetworkTool.js')();
 const Discovery = require('../net2/Discovery.js');
 const d = new Discovery();
 const Config = require('../net2/config.js');
 const PlatformLoader = require('../platform/PlatformLoader.js');
 const platform = PlatformLoader.getPlatform();

 class IPChangeSensor extends Sensor {
   async job() {
    if (PlatformLoader.getPlatform().isFireRouterManaged())
      return;
    const interfaces = await networkTool.listInterfaces();
    const config = await Config.getConfig(true);
    for (let i in interfaces) {
      const intf = interfaces[i];
      if (intf.conn_type === "Wired" && intf.name === config.monitoringInterface) {
        const ipv4Address = intf.ip_address;
        // TODO: support ipv6 address change detection
        // const ipv6Addresses = intf.ip6_addresses || [];
        const currentIpv4Addr = sysManager.myDefaultWanIp();
        if (ipv4Address !== currentIpv4Addr) {
          // no need to await
          platform.onWanIPChanged(ipv4Address);

          // discoverInterfaces will publish message to trigger network info reload
          await d.discoverInterfacesAsync().catch((err) => {
            log.error("Failed to discover interfaces", err);
          });
        } else {
          log.info(`IP address of ${config.monitoringInterface} is not changed: ` + ipv4Address);
        }
        return; // do not publish additional ip change if ethx has multiple ip addresses
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
