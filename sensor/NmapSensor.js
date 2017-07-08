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

class NmapSensor extends Sensor {
  constructor() {
    super();
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
  
  run() {
    
  }
}

module.exports = NmapSensor;

