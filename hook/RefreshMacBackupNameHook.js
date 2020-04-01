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
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

class RefreshMacBackupNameHook extends Hook {

  run() {
    sem.on('RefreshMacBackupName', (event) => {
      let mac = event.mac;
      let name = event.name;
      
      // ignore unknown updates
      if(!name || name.toLowerCase() === "unknown")
        return;

      hostTool.macExists(mac)
        .then((result) => {
          if (!result)
            return;

          hostTool.updateBackupName(mac, name)
            .then(() => {
              await hostTool.generateLocalDomain(mac);
              await dnsmasq.setupLocalDeviceDomain([mac]);
            })
            .catch((err) => {
            log.error("Failed to update backup name: ", err);
          })
        })
    });
  }
}

module.exports = RefreshMacBackupNameHook;
