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

let util = require('util');

const MessageBus = require('../net2/MessageBus.js');

class NewDeviceHook extends Hook {

  constructor() {
    super();
    this.queue = [];
    this.messageBus = new MessageBus('info');
  }

  async findMac(name, mac, from, retry) {

    retry = retry || 0;

    let Discovery = require("../net2/Discovery.js");
    let d = new Discovery("nmap", null, "info", false);

    // get ip address and mac vendor
    try {
      let result = await d.discoverMac(mac)

      if(!result) {
        // not found... kinda strange, hack??
        let logString = util.format("New device %s (%s) is not found in the network", name, mac);
        log.warn(logString);

        // if first time, try again in another 10 seconds
        if(retry === 0) {
          setTimeout(() => this.findMac(name, mac, from, retry + 1),
            10 * 1000);
        }
        return;
      }

      log.info("Found a new device: " + name + "(" + mac + ")");

      result.bname = name;
      result.mac = mac;
      result.from = from

      sem.emitEvent({
        type: "DeviceUpdate",
        message: `A new device found @ NewDeviceHook ${result.mac} ${name}`,
        host: result
      });
      // d.processHost(result, (err, host, newHost) => {
      //   // alarm will be handled and created by "NewDevice" event
      //
      // });
    } catch(err) {
      log.error("Failed to discover mac address", mac, ": " + err);
      return;
    }
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      sem.on('NewDeviceWithMacOnly', async(event) => {

        let mac = event.mac;
        let name = event.name; // name should be fetched via DHCPDUMP
        let from = event.from;
  
        let HostTool = require('../net2/HostTool')
        let hostTool = new HostTool();
  
        if (from === "dhcp") {
          let mtype = event.mtype;
          // mtype should be either DHCPDISCOVER or DHCPREQUEST
  
          let dhcpInfo = {
            mac: mac,
            timestamp: new Date() / 1000
          };
          if (name) dhcpInfo.name = name
  
          await hostTool.updateDHCPInfo(mac, mtype, dhcpInfo);
        }
  
        const result = await hostTool.macExists(mac)
  
        if(result) {
          if(!name) {
            return // hostname is not provided by dhcp request, can't update name
          }
          
          log.info("MAC Address", mac, ` already exists, updating ${from}Name`);
          let hostObj = {
            mac: mac
          }
          const skey = `${from}Name`;
          hostObj[skey] = name;
          await hostTool.updateMACKey(hostObj, false);
          await hostTool.generateLocalDomain(mac);
          this.messageBus.publish("DiscoveryEvent", "Device:Updated", mac, hostObj);
          return;
        }
  
        // delay discover, this is to ensure ip address is already allocated
        // to this new device
        setTimeout(() => {
          log.info(require('util').format("Trying to inspect more info on host %s (%s)", name, mac))
          this.findMac(name, mac, event.from);
        }, 5000);
      });
    })
  }
}

module.exports = NewDeviceHook;
