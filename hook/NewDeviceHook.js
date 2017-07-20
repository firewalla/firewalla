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

let log = require('../net2/logger.js')(__filename, 'info');

let Hook = require('./Hook.js');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let bone = require("../lib/Bone.js");

let flowUtil = require("../net2/FlowUtil.js");

class NewDeviceHook extends Hook {

  findMac(name, mac, retry) {

    retry = retry || 0;

    let Discovery = require("../net2/Discovery.js");
    let d = new Discovery("nmap", null, "info", false);
    
    // get ip address and mac vendor
    d.discoverMac(mac, (err, result) => {
      if(err) {
        log.error("Failed to discover mac address", mac, ": " + err, {});
        return;
      }

      if(!result) {
        // not found... kinda strange, hack??
        log.warn("New device " + name + " is not found in the network..");

        // if first time, try again in another 10 seconds
        if(retry === 0) {
          setTimeout(() => this.findMac(mac, retry + 1),
                     10 * 1000);
        }
        return;
      }

      log.info("Found a new device: " + name + "(" + mac + ")");

      result.bname = name;
      result.mac = mac;

      sem.emitEvent({
        type: "DeviceUpdate",
        message: "A new device found @ NewDeviceHook",
        host: result
      });
      // d.processHost(result, (err, host, newHost) => {
      //   // alarm will be handled and created by "NewDevice" event
      //  
      // });
    });
  }
  
  run() {
    
    sem.on('NewDeviceWithMacOnly', (event) => {

      let mac = event.mac;
      let name = event.name; // name should be fetched via DHCPDUMP

      let HostTool = require('../net2/HostTool')
      let hostTool = new HostTool();

      hostTool.macExists(mac)
        .then((result) => {
          if(result) {
            log.info("MAC Address", mac, " already exists, updating backup name");
            sem.emitEvent({
              type: "RefreshMacBackupName",
              message: "Update device backup name via MAC Address",
              mac:mac,
              name: name
            });
            return;
          }

          // delay discover, this is to ensure ip address is already allocated
          // to this new device
          setTimeout(() => {
            this.findMac(name, mac);
          }, 5000);
        });
    });
  }
}

module.exports = NewDeviceHook;
