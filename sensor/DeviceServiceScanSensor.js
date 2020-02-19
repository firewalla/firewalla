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

const fc = require('../net2/config.js');

const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager("cli", 'client', 'info');

const sysManager = require('../net2/SysManager.js');

class DeviceServiceScanSensor extends Sensor {
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
  }

  isSensorEnable() {
    return fc.isFeatureOn("device_service_scan");
  }

  async checkAndRunOnce() {
    try {
      let result = await this.isSensorEnable();
      if (result) {
        return await this.runOnce();
      };
    } catch(err) {
      log.error('Failed to scan: ', err);
    };

    return null;
  }

  async runOnce() {
    log.info('Scan start...');

    let results = await hostManager.getHostsAsync();
    if (!results)
      throw new Error('Failed to scan.');

    let hosts = [];
    try {
      results = results.filter((host) => host && host.o && host.o.mac && host.o.ipv4Addr && host.o.ipv4Addr !== sysManager.myIp() && host.o.ipv4Addr !== sysManager.myIp2() && host.o.ipv4Addr !== sysManager.myWifiIp());
      for (const host of results) {
        log.info("Scanning device: ", host.o.ipv4Addr);
        const scanResult = await this._scan(host.o.ipv4Addr);
        if (scanResult) {
          await rclient.hsetAsync("host:mac:" + host.o.mac, "openports", JSON.stringify(scanResult));
        }
      };
    } catch(err) {
      log.error("Failed to scan: " + err);
    }

    return hosts;
  }

  _scan(ipAddr, callback) {
    let cmd = util.format('sudo nmap -Pn -F %s -oX - | %s', ipAddr, xml2jsonBinary);

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

        let nmapJSON = findings && findings.nmaprun && findings.nmaprun.host;
        resolve(this._parseNmapPortResult(nmapJSON));
      })
    });
  }

  static _handlePortEntry(portJson, openports) {
    if (portJson) {
      if (!openports[portJson.protocol])
        openports[portJson.protocol] = [];
      openports[portJson.protocol].push(portJson.portid * 1);
    }
  }

  _parseNmapPortResult(nmapResult) {
    let openports = {};
    openports.lastActiveTimestamp = Date.now() / 1000;
    try {
      let port = nmapResult && nmapResult.ports && nmapResult.ports.port;
      if (port && port.constructor === Object) {
        // one port only
        DeviceServiceScanSensor._handlePortEntry(port, openports);
      } else if (port && port.constructor === Array) {
        // multiple ports
        port.forEach((p) => DeviceServiceScanSensor._handlePortEntry(p, openports));
      }
    } catch(err) {
      log.error("Failed to parse nmap host: " + err);
    }
    return openports;
  }
}

module.exports = DeviceServiceScanSensor;
