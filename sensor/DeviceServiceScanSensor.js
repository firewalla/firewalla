/*    Copyright 2020-2021 Firewalla Inc.
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
const hostManager = new HostManager();
const sysManager = require('../net2/SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const extensionManager = require('./ExtensionManager.js')

const featureName = "device_service_scan";
const policyKeyName = "device_service_scan";

class DeviceServiceScanSensor extends Sensor {
  async run() {
    const defaultOn = (await rclient.hgetAsync('policy:system', policyKeyName)) === null; // backward compatibility
    this.scanSettings = {
      '0.0.0.0': defaultOn
    }

    sem.once('IPTABLES_READY', () => {
      let firstScanTime = this.config.firstScan * 1000 || 120 * 1000; // default to 120 seconds
      setTimeout(async () => {
        await this.checkAndRunOnce();
        sem.emitEvent({
          type: "DeviceServiceScanComplete",
          message: ""
        });
      }, firstScanTime);
    })

    let interval = this.config.interval * 1000 || 3 * 3600 * 1000; // 3 hours
    setInterval(() => {
      this.checkAndRunOnce();
    }, interval);

    extensionManager.registerExtension(policyKeyName, this, {
      applyPolicy: this.applyPolicy
    });
  }

  isSensorEnable() {
    return fc.isFeatureOn(featureName);
  }
  async applyPolicy(host, ip, policy) {
    log.info("Applying device service scan policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        this.scanSettings[ip] = policy;
      } else {
        if (!host)
          return;
        switch (host.constructor.name) {
          case "Tag": {
            const tagUid = host.o && host.o.uid;
            if (tagUid) {
              const allMacs = await hostManager.getTagMacs(tagUid);
              allMacs.map((mac) => {
                !this.scanSettings[mac] && (this.scanSettings[mac] = {})
                this.scanSettings[mac].tagPolicy = policy;
              })
            }
            break;
          }
          case "NetworkProfile": {
            const uuid = host.o && host.o.uuid;
            if (uuid) {
              const allMacs = hostManager.getIntfMacs(uuid);
              allMacs.map((mac) => {
                !this.scanSettings[mac] && (this.scanSettings[mac] = {})
                this.scanSettings[mac].networkPolicy = policy;
              })
            }
            break;
          }
          case "Host": {
            const macAddress = host && host.o && host.o.mac;
            if (!macAddress) return;
            !this.scanSettings[macAddress] && (this.scanSettings[macAddress] = {})
            this.scanSettings[macAddress].devicePolicy = policy;
            break;
          }
          default:
        }
      }
    } catch (err) {
      log.error("Got error when applying device service scan policy", err);
    }
  }

  async checkAndRunOnce() {
    try {
      let result = await this.isSensorEnable();
      if (result) {
        return await this.runOnce();
      }
    } catch (err) {
      log.error('Failed to scan: ', err);
    }

    return null;
  }

  async runOnce() {
    log.info('Scan start...');

    let hosts = await hostManager.getHostsAsync();
    if (!hosts)
      throw new Error('Failed to scan.');

    try {
      hosts = hosts.filter((host) => {
        const validHost = host && host.o && host.o.mac && host.o.ipv4Addr && !sysManager.isMyIP(host.o.ipv4Addr);
        if (!validHost) return false;
        const mac = host.o.mac;
        const setting = this.scanSettings[mac];
        /* 
          same as adblock/familyProtect
          policy === null // exclude
          policy === false | undefined // unset
        */
        if (!setting) return this.scanSettings['0.0.0.0'];
        if (setting.devicePolicy === true) return true
        if (setting.devicePolicy === null) return false
        if (setting.tagPolicy === true) return true
        if (setting.tagPolicy === null) return false
        if (setting.networkPolicy === true) return true
        if (setting.networkPolicy === null) return false
        if (this.scanSettings['0.0.0.0'] === true) return true
        if (this.scanSettings['0.0.0.0'] === null) return false
        return false;
      });
      for (const host of hosts) {
        log.info("Scanning device: ", host.o.ipv4Addr);
        const scanResult = await this._scan(host.o.ipv4Addr);
        if (scanResult) {
          const hostKeyExists = await rclient.existsAsync(`host:mac:${host.o.mac}`);
          // in case host entry is deleted when the scan is in progress
          if (hostKeyExists == 1)
            await rclient.hsetAsync("host:mac:" + host.o.mac, "openports", JSON.stringify(scanResult));
        }
      }
    } catch (err) {
      log.error("Failed to scan: " + err);
    }
    log.info('Scan finished...');
    return hosts;
  }

  _scan(ipAddr) {
    let cmd = util.format('sudo timeout 1200s nmap -Pn --top-ports 3000 %s -oX - | %s', ipAddr, xml2jsonBinary);

    log.info("Running command:", cmd);
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
    } catch (err) {
      log.error("Failed to parse nmap host: " + err);
    }
    return openports;
  }
}

module.exports = DeviceServiceScanSensor;
