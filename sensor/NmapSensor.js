/*    Copyright 2016-2024 Firewalla Inc.
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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;
const { exec } = require('child-process-promise')

const Firewalla = require('../net2/Firewalla');
const nmap = require('../net2/Nmap.js');

const sysManager = require('../net2/SysManager.js')
const networkTool = require('../net2/NetworkTool')();

const Message = require('../net2/Message.js');

const PlatformLoader = require('../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();
const OUI_ASSET_PATH = '/home/pi/.firewalla/run/assets/nmap-mac-prefixes'
const { Address4 } = require('ip-address')

class NmapSensor extends Sensor {
  constructor(config) {
    super(config);
    this.interfaces = null;
    this.rounds = 0;
    this.enabled = true; // very basic feature, always enabled

    let p = require('../net2/MessageBus.js');
    this.publisher = new p('info', 'Scan:Done', 10);
  }


  getScanInterfaces() {
    return sysManager.getMonitoringInterfaces().filter(i => i.name && !i.name.includes("vpn") && !i.name.startsWith("wg") && !i.name.startsWith("awg")) // do not scan vpn interface
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.checkAndRunOnce(false);
    }, 5000);
  }

  static async getOUI(mac) {
    try {
      const rawMAC = mac.toUpperCase().replace(/:/g, '')
      const result = await exec(`awk '"${rawMAC}" ~ "^" $1 {$1=""; print $0}' ${OUI_ASSET_PATH}`)
      const lines = result.stdout.trim().split('\n').filter(Boolean)
      if (lines.length)
        // use last (longest) match
        return lines[lines.length - 1].trim()
      else
        return null
    } catch(err) {
      log.error('Error looking up OUI data', err)
      return null
    }
  }

  run() {
    // patch script for error "Failed to scan: Error: next_template: parse error (cpe delimiter not '/') on line 11594 of nmap-service-probes"
    exec(String.raw`sudo sed -i 's/cpe:|h:siemens:315-2pn\/dp|/cpe:\/h:siemens:315-2pn%2Fdp\//' /usr/share/nmap/nmap-service-probes`).catch(()=>{})

    // uses the latest OUI DB if possible
    exec(`sudo cp -f ${OUI_ASSET_PATH} /usr/share/nmap/nmap-mac-prefixes`).catch(()=>{})

    this.scheduleReload();
    setInterval(() => {
      this.checkAndRunOnce(false);
    }, 1000 * 60 * 120); // every 120 minutes, slow scan
    setInterval(() => {
      this.checkAndRunOnce(true);
    }, 1000 * 60 * 5); // every 5 minutes, fast scan

    /* nmap scan is no longer essential for device discovery, we have flow, ARPSensor, DHCPSensor, and ICMP6Sensor
       so we don't need to run it immediately after network info is reloaded to reduce CPU overhead
    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload NmapSensor since network info is reloaded");
      this.scheduleReload();
    })
      */
  }

  checkAndRunOnce(fastMode) {
    if (this.isSensorEnabled()) {
      this.runOnce(fastMode)
    }
  }

  async runOnce(fastMode) {
    const interfaces = this.getScanInterfaces()

    if (!interfaces)
      log.error("Failed to get interface list");

    for (const intf of interfaces) {

      let range = intf.subnet

      try {
        range = networkTool.capSubnet(range)
      } catch (e) {
        log.error('Error reducing scan range:', range, fastMode, e);
        continue // Skipping this scan
      }

      log.info(`Scanning network ${range} (fastMode: ${fastMode}) ...`);

      try {
        // use ARP broadcast scan and ICMP/TCP scan in turn, this can reduce broadcast packets compared to using ARP broadcast scan alone
        const options = fastMode ? {
          protocols: [1, 6],  // protocol id 1, 6 corresponds to ICMP and TCP
          sendIp: this.rounds % 2 === 0  // rotate --send-ip flag
        } : {
          script: 'nbstat.nse',
          ports: [137]
        }
        const hosts = await nmap.scanAsync(range, options)
        log.verbose("Analyzing scan result...", range);

        if (hosts.length === 0) {
          log.info("No device is found for network", range);
          continue;
        }

        for (const host of hosts) {
          await this._processHost(host, intf)
        }
      } catch(err) {
        log.error("Failed to scan:", err);
        await this._processHost({ipv4Addr: intf.ip_address, mac: (intf.mac_address && intf.mac_address).toUpperCase()}, intf);
      }
    }

    this.rounds++;

    setTimeout(() => {
      log.info("publish Scan:Done after scan is finished")
      this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
    }, await Firewalla.isBootingComplete() ? 3000 : 7000)
  }

  async _processHost(host, intf) {
    log.debug("Found device:", host.ipv4Addr, host.mac);

    if ( platform.isOverlayNetworkAvailable() ) {
      if (host.ipv4Addr && host.ipv4Addr === sysManager.myIp2()) {
        log.debug("Ignore Firewalla's overlay IP")
        return
      }

      const ip4 = new Address4(host.ipv4Addr)
      const defIntf = sysManager.getDefaultWanInterface()
      const gatewayMac = await sysManager.myGatewayMac(defIntf.name)
      if (ip4.isInSubnet(defIntf.subnetAddress4) && host.mac == gatewayMac) {
        log.warn('Ignore gateway on overlay network')
        return
      }
    }

    if (!host.mac) {
      if (host.ipv4Addr && host.ipv4Addr === sysManager.myIp(intf.name)) {
        host.mac = sysManager.myMAC(intf.name)
      }
      if (!host.mac) {
        log.warn("Unidentified MAC Address for host", host);
        return
      }
    }

    if (host && host.mac) {

      const hostInfo = {
        ipv4: host.ipv4Addr,
        ipv4Addr: host.ipv4Addr,
        mac: host.mac,
        macVendor: host.macVendor,
        intf_mac: intf.mac_address,
        intf_uuid: intf.uuid,
        from: "nmap"
      };

      if (!host.macVendor || host.macVendor === 'Unknown') {
        delete hostInfo.macVendor;
      }

      // Extract nbtName from script object
      if (host.script && host.script.nbstat && host.script.nbstat.nbtName) {
        hostInfo.nbtName = host.script.nbstat.nbtName;
      }

      sem.emitEvent({
        type: "DeviceUpdate",
        message: `Found a device via NmapSensor ${hostInfo.ipv4} ${hostInfo.mac}`,
        suppressEventLogging: true,
        host: hostInfo
      });
    }
  }

  isSensorEnabled() {
    return this.enabled;
  }

}

module.exports = NmapSensor;
