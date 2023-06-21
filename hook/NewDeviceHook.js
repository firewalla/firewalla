/*    Copyright 2016-2023 Firewalla Inc.
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
const { delay } = require('../util/util')

const MessageBus = require('../net2/MessageBus.js');

class NewDeviceHook extends Hook {

  constructor() {
    super();
    this.queue = [];
    this.messageBus = new MessageBus('info');
  }

  async findMac(name, mac, from) {
    const Discovery = require("../net2/Discovery.js");
    const d = new Discovery("nmap", null, "info", false);

    // get ip address and mac vendor
    try {
      const result = await d.discoverMac(mac) || {}

      log.info("Found a new device: " + name + "(" + mac + ")");

      return result
    } catch(err) {
      log.error("Failed to discover mac address", mac, ": " + err);
      return {}
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
          log.verbose("MAC Address", mac, ` already exists, updating ${from}Name`);
          let hostObj = {
            mac: mac,
            lastActiveTimestamp: new Date() / 1000
          }
          const skey = `${from}Name`;
          if (name) hostObj[skey] = name;
          await hostTool.updateMACKey(hostObj);
          await hostTool.generateLocalDomain(mac);
          this.messageBus.publish("Host:Updated", mac, hostObj);
          return;
        }

        // delay discover, this is to ensure ip address is already allocated
        // to this new device
        await delay(5000)
        log.info("Trying to inspect more info on host", name, mac)
        const nmapResult = await this.findMac(name, mac, event.from);

        if (name) nmapResult.bname = name;

        sem.emitEvent({
          type: "DeviceUpdate",
          message: `A new device found @ NewDeviceHook ${mac} ${name}`,
          host: Object.assign(nmapResult, {
            mac,
            from,
            firstFoundTimestamp: new Date() / 1000,
            lastActiveTimestamp: new Date() / 1000,
            intf_mac: event.intf_mac,
            intf_uuid: event.intf_uuid,
          })
        });
      });
    })
  }
}

module.exports = NewDeviceHook;
