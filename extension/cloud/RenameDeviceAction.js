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

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

class RenameDeviceAction extends CloudAction {

  requiredKeys() {
    return ["hostID", "targetName"];
  }

  async run(info = {}) {
    // hostID is hash, need to find the mac address mapping to the hostID
    const mac = await hostTool.findMacByMacHash(info.hostID);
    if(!mac) {
      log.error("Mac Address not found for hash", info.hostID);
      return false;
    }

    const HostManager = require('../../net2/HostManager.js');
    const hm = new HostManager();
    const host = await hm.getHostAsync(mac);
    if(!host) {
      log.error(`Host not found for host id ${info.hostID}`);
      return false;
    }

    if(host.o) {
      host.o.cloudName = info.targetName;
    }

    const cloudName = info.targetName;

    await hostTool.updateMACKey({mac, cloudName}, false);

    return true;
  }
}

module.exports = RenameDeviceAction;
