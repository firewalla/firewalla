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

const log = require('../net2/logger.js')(__filename);

const util = require('util');

const Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient();

const cp = require('child_process');

const Firewalla = require('../net2/Firewalla');

const xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();

const PublicIPSensor = require('../sensor/PublicIPSensor');
const pips = new PublicIPSensor();

class ExternalScanSensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    let firstScanTime = (120 + Math.random() * 60) * 1000; // 120 ~ 180 seconds
    setTimeout(() => {
      this.checkAndRunOnce();
    }, firstScanTime);

    let interval = 30 * 60 * 1000; // 30 minutes
    setInterval(() => {
      this.checkAndRunOnce();
    }, interval);
  }

  isSensorEnable() {
    return true;
  }

  async checkAndRunOnce() {
    try {
      let result = await this.isSensorEnable();
      if (result) {
        return await this.runOnce();
      };
    } catch(err) {
      log.error('Failed to scan external ports: ', err);
    };

    return null;
  }

  async runOnce() {
    log.info('External scan start...');

    await pips.job();
    let publicIP = await rclient.hgetAsync("sys:network:info", "publicIp");

    log.info('External scan ports: ', publicIP);
    if (!publicIP)
      throw new Error('Failed to scan external ports.');
    
    let host = await this._scan(publicIP);
    //log.info('Analyzing external scan result...', host);

    const key = "sys:scan:external";
    try {
      log.info("External ports is updated,", host.scan.length, "entries");
      let redisHost = Object.assign({}, host);
      redisHost.scan = JSON.stringify(host.scan);
      await rclient.hmsetAsync(key, redisHost);
      await rclient.expireAsync(key, 86400);
    } catch(err) {
      log.error("Failed to scan external ports: " + err);
    }

    return host;
  }

  _scan(publicIP) {
    let cmd = util.format('sudo nmap -Pn -F %s -oX - | %s', publicIP, xml2jsonBinary);

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
          reject(new Error("Invalid nmap scan result,", cmd));
          return;
        }

        let hostJSON = findings.nmaprun && findings.nmaprun.host;
        if(!hostJSON) {
          reject(new Error("Invalid nmap scan result,", cmd));
          return;
        }

        resolve(this._parseNmapHostResult(hostJSON));
      })
    });
  }

  _handleAddressEntry(address, host) {
    if (address) {
      switch(address.addrtype) {
        case "ipv4":
          host.ip = address.addr;
          break;
        case "mac":
          host.mac = address.addr;
          host.macVendor = address.vendor || "Unknown";
          break;
        default:
          break;
      }
    }
  }

  _handlePortEntry(portJson, host) {
    if(!host.scan)
      host.scan = [];

    let thisPort = {};
    if (portJson) {
      thisPort.portid = portJson.portid;
      thisPort.uid = host.ip + "." + portJson.portid;
      thisPort.protocol = portJson.protocol;
      thisPort.lastActiveTimestamp = Date.now() / 1000;
      thisPort.hostId = host.ip;

      if(portJson.service) {
        thisPort.serviceName = portJson.service.name;
      }

      if(portJson.state) {
        thisPort.state = portJson.state.state;
      }
      host.scan.push(thisPort);
    }
  }

  _parseNmapHostResult(hostResult) {
    let host = {};
    try {
      let address = hostResult.address;

      if(address && address.constructor === Object) {
        // one address only
        this._handleAddressEntry(address, host);
      } else if(address && address.constructor === Array) {
        // multiple addresses
        address.forEach((a) => this._handleAddressEntry(a, host));
      }

      if (!host.ip)
        host.ip = "";

      let port = hostResult.ports && hostResult.ports.port;

      if(port && port.constructor === Object) {
        // one port only
        this._handlePortEntry(port, host);
      } else if(port && port.constructor === Array) {
        // multiple ports
        port.forEach((p) => this._handlePortEntry(p, host));
      }
    } catch(err) {
      log.error("Failed to parse nmap host: " + err);
    }
    return host;
  }
}

module.exports = ExternalScanSensor;
