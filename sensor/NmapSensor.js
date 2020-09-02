/*    Copyright 2016-2020 Firewalla Inc.
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
const cp = require('child_process');

const Firewalla = require('../net2/Firewalla');

const xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();

const sysManager = require('../net2/SysManager.js')
const networkTool = require('../net2/NetworkTool')();

const Message = require('../net2/Message.js');

const PlatformLoader = require('../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();

const { Address4 } = require('ip-address')

class NmapSensor extends Sensor {
  constructor() {
    super();
    this.interfaces = null;
    this.enabled = true; // very basic feature, always enabled

    let p = require('../net2/MessageBus.js');
    this.publisher = new p('info', 'Scan:Done', 10);
  }

  static _handleAddressEntry(address, host) {
    switch (address.addrtype) {
      case "ipv4":
        host.ipv4Addr = address.addr;
        break;
      case "mac":
        host.mac = address.addr;
        host.macVendor = address.vendor || "Unknown";
        break;
      default:
        break;
    }
  }

  static _handlePortEntry(portJson, host) {
    if (!host.ports)
      host.ports = [];

    let thisPort = {};

    thisPort.protocol = portJson.protocol;
    thisPort.port = portJson.portid;

    if (portJson.service) {
      thisPort.serviceName = portJson.service.name;
    }

    if (portJson.state) {
      thisPort.state = portJson.state.state;
    }

    host.ports.push(thisPort);
  }

  //TODO: parse more payloads from nmap script
  static _handleScriptTable(tableJSON, script) {

  }

  static _handleHostScript(scriptJSON, host) {
    if (!host.scripts)
      host.scripts = [];

    let script = {};

    script.id = scriptJSON.id;

    let table = scriptJSON.table;

    if (table) {
      script.key = table.key;

      if (table.elem && table.elem.constructor === Array) {
        table.elem.forEach((x) => {
          switch (x.key) {
            case "state":
              script.state = x["#content"];
              break;
            case "disclosure":
              script.disclosure = x["#content"];
              break;
            case "title":
              script.title = x["#content"];
              break;
            default:
          }
        });
      }
    }

    host.scripts.push(script);
  }

  static parseNmapHostResult(hostResult) {
    let host = {};

    if (hostResult.hostnames &&
      hostResult.hostnames.constructor === Object) {
      host.hostname = hostResult.hostnames.hostname.name;
      host.hostnameType = hostResult.hostnames.hostname.type;
    }

    let address = hostResult.address;

    if (address && address.constructor === Object) {
      // one address only
      NmapSensor._handleAddressEntry(address, host);
    } else if (address && address.constructor === Array) {
      // multiple addresses
      address.forEach((a) => NmapSensor._handleAddressEntry(a, host));
    }

    let port = hostResult.ports && hostResult.ports.port;

    if (port && port.constructor === Object) {
      // one port only
      NmapSensor._handlePortEntry(port, host);
    } else if (port && port.constructor === Array) {
      // multiple ports
      port.forEach((p) => NmapSensor._handlePortEntry(p, host));
    }

    if (hostResult.os && hostResult.os.osmatch) {
      host.os_match = hostResult.os.osmatch.name;
      host.os_accuracy = hostResult.os.osmatch.accuracy;
      host.os_class = JSON.stringify(hostResult.os.osmatch.osclass);
    }

    if (hostResult.uptime) {
      host.uptime = hostResult.uptime.seconds;
    }

    let hs = hostResult.hostscript;
    if (hs && hs.script &&
      hs.script.constructor === Object) {
      NmapSensor._handleHostScript(hs.script, host);
    } else if (hs && hs.script &&
      hs.script.constructor === Array) {
      hs.script.forEach((hr) => NmapSensor._handleHostScript(hr, host));
    }

    return host;
  }

  getScanInterfaces() {
    return sysManager.getMonitoringInterfaces().filter(i => i.name && !i.name.includes("vpn")) // do not scan vpn interface
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.checkAndRunOnce(false);
    }, 5000);
  }

  run() {
    this.scheduleReload();
    setInterval(() => {
      this.checkAndRunOnce(false);
    }, 1000 * 60 * 120); // every 120 minutes, slow scan
    setInterval(() => {
      this.checkAndRunOnce(true);
    }, 1000 * 60 * 5); // every 5 minutes, fast scan

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload NmapSensor since network info is reloaded");
      this.scheduleReload();
    })
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
        return // Skipping this scan
      }

      log.info("Scanning network", range, "to detect new devices...");


      const cmd = fastMode
        ? `sudo timeout 1200s nmap -sn -PO ${intf.type === "wan" ? '--send-ip': ''} --host-timeout 30s  ${range} -oX - | ${xml2jsonBinary}`
        : `sudo timeout 1200s nmap -sU --host-timeout 200s --script nbstat.nse -p 137 ${range} -oX - | ${xml2jsonBinary}`;

      try {
        const hosts = await NmapSensor.scan(cmd)
        log.info("Analyzing scan result...");

        if (hosts.length === 0) {
          log.info("No device is found for network", range);
          return;
        }

        for (const host of hosts) {
          await this._processHost(host, intf)
        }
      } catch(err) {
        log.error("Failed to scan:", err);
      }
    }

    setTimeout(() => {
      log.info("publish Scan:Done after scan is finished")
      this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
    }, 3 * 1000)

    Firewalla.isBootingComplete()
      .then((result) => {
        if (!result) {
          setTimeout(() => {
            log.info("publish Scan:Done after scan is finished")
            this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
          }, 7 * 1000)
        }
      })
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
      } else if (host.ipv4Addr && host.ipv4Addr === sysManager.myWifiIp(intf.name)) {
        host.mac = sysManager.myWifiMAC(intf.name);
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

      if (host.macVendor === 'Unknown') {
        delete hostInfo.macVendor;
      }

      sem.emitEvent({
        type: "DeviceUpdate",
        message: `Found a device via NmapSensor ${hostInfo.ipv4} ${hostInfo.mac}`,
        suppressEventLogging: true,
        suppressAlarm: this.suppressAlarm,
        host: hostInfo
      });
    }
  }

  isSensorEnabled() {
    return this.enabled;
  }

  static scan(cmd) {
    log.debug("Running command:", cmd);

    return new Promise((resolve, reject) => {
      cp.exec(cmd, (err, stdout, stderr) => {

        if (err || stderr) {
          reject(err || new Error(stderr));
          return;
        }

        let findings = null;
        try {
          findings = JSON.parse(stdout);
        } catch (err) {
          reject(err);
        }

        if (!findings) {
          reject(new Error("Invalid nmap scan result,", cmd));
          return;
        }

        let hostsJSON = findings.nmaprun && findings.nmaprun.host;

        if (!hostsJSON) {
          reject(new Error("Invalid nmap scan result,", cmd));
          return;
        }

        if (hostsJSON.constructor !== Array) {
          hostsJSON = [hostsJSON];
        }

        let hosts = hostsJSON.map(NmapSensor.parseNmapHostResult);

        resolve(hosts);
      })
    });

  }
}

module.exports = NmapSensor;
