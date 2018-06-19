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

let log = require('../net2/logger.js')(__filename);

let util = require('util');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let Sensor = require('./Sensor.js').Sensor;

let networkTool = require('../net2/NetworkTool')();
let cp = require('child_process');

let Firewalla = require('../net2/Firewalla');

let xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();

const SysManager = require('../net2/SysManager.js')
const sysManager = new SysManager('info')

class NmapSensor extends Sensor {
  constructor() {
    super();

    this.networkInterface = networkTool.getLocalNetworkInterface();
    // this.networkRange = this.networkInterface && this.networkInterface.subnet;
    this.enabled = true; // very basic feature, always enabled

    let p = require('../net2/MessageBus.js');
    this.publisher = new p('info','Scan:Done', 10);
  }

  static _handleAddressEntry(address, host) {
    switch(address.addrtype) {
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
    if(!host.ports)
      host.ports = [];

    let thisPort = {};

    thisPort.protocol = portJson.protocol;
    thisPort.port = portJson.portid;

    if(portJson.service) {
      thisPort.serviceName = portJson.service.name;
    }

    if(portJson.state) {
      thisPort.state = portJson.state.state;
    }

    host.ports.push(thisPort);
  }

  //TODO: parse more payloads from nmap script
  static _handleScriptTable(tableJSON, script) {

  }

  static _handleHostScript(scriptJSON, host) {
    if(!host.scripts)
      host.scripts = [];

    let script = {};

    script.id = scriptJSON.id;

    let table = scriptJSON.table;

    if(table) {
      script.key = table.key;

      if(table.elem && table.elem.constructor === Array) {
        table.elem.forEach((x) => {
          switch(x.key) {
            case "state":
              script.state = x["#content"];
              break;
            case "disclosure":
              script.disclosure = x["#content"];
              break;
            case "title":
              script.title = x["#content"];
            default:
              break;
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

    if(address && address.constructor === Object) {
      // one address only
      NmapSensor._handleAddressEntry(address, host);
    } else if(address && address.constructor === Array) {
      // multiple addresses
      address.forEach((a) => NmapSensor._handleAddressEntry(a, host));
    }

    let port = hostResult.ports && hostResult.ports.port;

    if(port && port.constructor === Object) {
      // one port only
      NmapSensor._handlePortEntry(port, host);
    } else if(port && port.constructor === Array) {
      // multiple ports
      port.forEach((p) => NmapSensor._handlePortEntry(p));
    }

    if(hostResult.os && hostResult.os.osmatch) {
      host.os_match = hostResult.os.osmatch.name;
      host.os_accuracy = hostResult.os.osmatch.accuracy;
      host.os_class = JSON.stringify(hostResult.os.osmatch.osclass);
    }

    if(hostResult.uptime) {
      host.uptime = hostResult.uptime.seconds;
    }

    let hs = hostResult.hostscript;
    if(hs && hs.script &&
      hs.script.constructor === Object) {
      NmapSensor._handleHostScript(hs.script, host);
    } else if(hs && hs.script &&
      hs.script.constructor === Array) {
      hs.script.forEach((hr) => NmapSensor._handleHostScript(hr, host));
    }

    return host;
  }

  getNetworkRanges() {
    return networkTool.getLocalNetworkInterface()
      .then((results) => {
      this.networkRanges = results &&
        results.map((x) => x.subnet)
          .map((subnet) => {
          return subnet.replace('/16', '/24') // a very hard code for 16 subnet
        }) ;
      return this.networkRanges;
      });
  }

  run() {
    process.nextTick(() => {
      this.checkAndRunOnce(false);
    });
    setInterval(() => {
      this.checkAndRunOnce(false);
    }, 1000 * 60 * 120); // every 120 minutes, slow scan
    setInterval(() => {
      this.checkAndRunOnce(true);
    }, 1000 * 60 * 5); // every 5 minutes, fast scan
  }

  checkAndRunOnce(fastMode) {
    return this.isSensorEnable()
      .then((result) => {
        if(result) {
          return this.getNetworkRanges()
            .then(() => {
              return this.runOnce(fastMode)
            })
        }
      }).catch((err) => {
      log.error("Failed to check if sensor is enabled", err, {});
    })
  }

  runOnce(fastMode) {
    if(!this.networkRanges)
      return Promise.reject(new Error("network range is required"));

    return Promise.all(this.networkRanges.map((range) => {

      log.info("Scanning network", range, "to detect new devices...");

      let cmd = util.format('sudo nmap -sU --host-timeout 200s --script nbstat.nse -p 137 %s -oX - | %s', range, xml2jsonBinary);
      if (fastMode === true) {
        cmd = util.format('sudo nmap -sn -PO --host-timeout 30s  %s -oX - | %s', range, xml2jsonBinary);
      }

      return NmapSensor.scan(cmd)
        .then((hosts) => {
          log.info("Analyzing scan result...");

          if(hosts.length === 0) {
            log.info("No device is found for network", range, {});
            return;
          }
          hosts.forEach((h) => {
            log.debug("Found device:", h.ipv4Addr, {});
            this._processHost(h);
          })

        }).catch((err) => {
          log.error("Failed to scan:", err, {});
        });
    })).then(() => {
      setTimeout(() => {
        log.info("publish Scan:Done after scan is finished")
        this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
      }, 3 * 1000)

      Firewalla.isBootingComplete()
        .then((result) => {
          if(!result) {
            setTimeout(() => {
              log.info("publish Scan:Done after scan is finished")
              this.publisher.publish("DiscoveryEvent", "Scan:Done", '0', {});
            }, 7 * 1000)
          }
        })      
    });
  }

  _processHost(host) {
    if(!host.mac) {
      if(host.ipv4Addr && host.ipv4Addr === sysManager.myIp()) {
        host.mac = sysManager.myMAC()
      } else if(host.ipv4Addr && host.ipv4Addr === sysManager.myIp2()) {
        return // do nothing on secondary ip
      } else {
        log.error("Invalid MAC Address for host", host, {})
        return
      }
    }
    
    if(host && host.mac) {
      sem.emitEvent({
        type: "DeviceUpdate",
        message: "Found a device via NmapSensor",
        suppressEventLogging: true,
        suppressAlarm: this.suppressAlarm,
        host:  {
          ipv4: host.ipv4Addr,
          ipv4Addr: host.ipv4Addr,
          mac: host.mac,
          macVendor: host.macVendor,
          from: "nmap"
        }
      });
    }
  }

  isSensorEnable() {
    return Promise.resolve(this.enabled);
  }

  static scan(cmd) {
    log.info("Running command:", cmd);

    return new Promise((resolve, reject) => {
      cp.exec(cmd, (err, stdout, stderr) => {

        if(err || stderr) {
          reject(err || new Error(stderr));
          return;
        }

        let findings = null;
        try {
          findings = JSON.parse(stdout);
        } catch (err) {
          reject(err);
        }

        if(!findings) {
          return;
        }

        let hostsJSON = findings.nmaprun && findings.nmaprun.host;

        if(!hostsJSON)
          return;

        if(hostsJSON.constructor !== Array) {
          hostsJSON = [hostsJSON];
        }

        let hosts = hostsJSON.map(NmapSensor.parseNmapHostResult);

        resolve(hosts);
      })
    });

  }
}

module.exports = NmapSensor;
