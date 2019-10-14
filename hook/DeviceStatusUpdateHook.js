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

const log = require('../net2/logger.js')(__filename, 'info');

const Hook = require('./Hook.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

class DeviceStatusUpdateHook extends Hook {
  constructor() {
    super();
  }

  run() {
    sem.on("DeviceStatusUpdate", async (event) => {
      let host = event.host;
      if(!host)
        return;

      try {
        await this.updateIPv6entries(host.ipv6Addrs) // ignore err
        const oldHost = await hostTool.getIPv4Entry(host.ipv4Addr)
        let mergedHost = hostTool.mergeHosts(oldHost, host);
        log.info("mergedHost", mergedHost);
        await hostTool.updateIPv4Host(mergedHost)
        log.info("Updated host info for device ", mergedHost.bname, "(", mergedHost.ipv4, ")");
      } catch(err) {
        log.error("Failed to updateIPv4Host: ", err);
      }
    });
  }

  async updateIPv6entries(ipv6Addrs) {
    if(!ipv6Addrs || ipv6Addrs.length == 0) {
      return;
    }

    // update link between ipv6 and mac
    for (const v6addr of ipv6Addrs) {
      await this.hostTool.linkMacWithIPv6(v6addr, mac)
    }
  }
}

module.exports = DeviceStatusUpdateHook
