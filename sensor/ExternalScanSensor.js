/*    Copyright 2020 Firewalla INC 
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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const fc = require('../net2/config.js');

const redisKey = "sys:scan:external";
const redisIpKey = "sys:network:info";
const redisIpField = "publicIp";

const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

function comparePort(a, b) {
  return a.portid == b.portid && a.protocol  == b.protocol;
}

class ExternalScanSensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    let firstScanTime = this.config.firstScan * 1000 || 120 * 1000; // default to 120 seconds
    setTimeout(() => {
      this.checkAndRunOnce();
    }, firstScanTime);

    let interval = this.config.interval * 1000 || 30 * 60 * 1000; // 30 minutes
    setInterval(() => {
      this.checkAndRunOnce();
    }, interval);

    sem.on("PublicIP:Updated", (event) => {
      this.checkAndRunOnce();
    });
  }

  isSensorEnable() {
    return fc.isFeatureOn("external_scan");
  }

  async getExternalPorts() {
    try {
      const result = await rclient.hgetallAsync(redisKey);
      if (result && result.scan) {
        const lastFoundTimestamp = result.lastActiveTimestamp;
        if (lastFoundTimestamp && lastFoundTimestamp > new Date() / 1000 - 300) {  //valid for 5 minutes
          let publicIP = await rclient.hgetAsync(redisIpKey, redisIpField);
          try {
            publicIP = JSON.parse(publicIP);
          } catch (err) {
            log.error("Failed to parse strings:", publicIP);
          }
          if (result.ip == publicIP) {
            result.scan = JSON.parse(result.scan);
            return result;
          }
        }
      }

      return await this.runOnce();
    } catch(err) {
      log.error('Failed to get external ports: ', err);
    };

    return null;
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

    let publicIP = await rclient.hgetAsync(redisIpKey, redisIpField);

    if (!publicIP)
      throw new Error('Failed to scan external ports.');

    try {
      publicIP = JSON.parse(publicIP);
    } catch (err) {
      log.error("Failed to parse strings:", publicIP);
    }

    log.info('External scan ports: ', publicIP);
    let host = await this._scan(publicIP);
    //log.info('Analyzing external scan result...', host);

    try {
      let entries = await rclient.hgetAsync(redisKey, 'scan');
      let preEntries = JSON.parse(entries) || [];
      let openPorts = [];
      let waitedPorts = [];
      for (let current of host.scan) {
        if (!preEntries.some(pre => comparePort(pre, current))) {
          waitedPorts.push(current);
        } else {
          openPorts.push(current);
        }
      }

      let confirmedPorts = await this.cloudScanPorts(host.ip, waitedPorts);
      openPorts.push.apply(openPorts, confirmedPorts);
      host.scan = openPorts;

      log.info("External ports is updated,", host.scan.length, "entries");
      let redisHost = Object.assign({}, host);
      redisHost.scan = JSON.stringify(host.scan);
      await rclient.hmsetAsync(redisKey, redisHost);
      await rclient.expireAsync(redisKey, 86400);
    } catch(err) {
      log.error("Failed to scan external ports: " + err);
    }

    return host;
  }

  async cloudScanPorts(publicIP, waitedPorts) {
    //Cloud confirm whether the port is open
    const confirmedPorts = waitedPorts;
    try {
      //
      if (fc.isFeatureOn("alarm_openport")) {
        for (let current of confirmedPorts) {
          let alarm = new Alarm.OpenPortAlarm(
            new Date() / 1000,
            current.serviceName,
            {
              'p.source': 'ExternalScanSensor',
              'p.public.ip': publicIP,
              'p.device.ip': 'unknown',
              'p.open.port': current.portid,
              'p.open.protocol': current.protocol,
              'p.open.state': current.state,
              'p.open.servicename': current.serviceName
            }
          );

          await am2.enqueueAlarm(alarm);
        }
      }
    } catch(err) {
      log.error("Failed to clound confirm ports: " + err);
    }

    return confirmedPorts;
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

  static _handleAddressEntry(address, host) {
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

  static _handlePortEntry(portJson, host) {
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
        ExternalScanSensor._handleAddressEntry(address, host);
      } else if(address && address.constructor === Array) {
        // multiple addresses
        address.forEach((a) => ExternalScanSensor._handleAddressEntry(a, host));
      }

      if (!host.ip)
        host.ip = "";
      host.lastActiveTimestamp = new Date() / 1000;

      let port = hostResult.ports && hostResult.ports.port;

      if(port && port.constructor === Object) {
        // one port only
        ExternalScanSensor._handlePortEntry(port, host);
      } else if(port && port.constructor === Array) {
        // multiple ports
        port.forEach((p) => ExternalScanSensor._handlePortEntry(p, host));
      }
    } catch(err) {
      log.error("Failed to parse nmap host: " + err);
    }
    return host;
  }
}

module.exports = ExternalScanSensor;