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

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;
const systemConfigFile = `${dnsmasqConfigFolder}/ss2_system.conf`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const fc = require('../net2/config.js');

const featureName = "ss2";

const ss2 = require('../extension/ss2/ss2.js');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class SS2Plugin extends Sensor {
  async run() {
    if(platform.getName() !== 'gold') {
      return;
    }
    
    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.enabledMacAddresses = {};

    await exec(`mkdir -p ${dnsmasqConfigFolder}`);

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });
      
    this.hookFeature(featureName);

    sem.on('SS2_REFRESH', (event) => {
      this.applyAll();
    });
    
  }

  async job() {
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying ss2 policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state === true) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applySS2();
      } else {
        const macAddress = host && host.o && host.o.mac;
        if (macAddress) {
          if (policy && policy.state === true) {
            this.enabledMacAddresses[macAddress] = 1;
          } else {
            delete this.enabledMacAddresses[macAddress];
          }
          return this.applyDeviceSS2(macAddress);
        }
      }
    } catch (err) {
      log.error("Got error when applying doh policy", err);
    }
  }

  async applyAll(options = {}) {
    log.info("Applying...");
    const config = await this.getFeatureConfig();
    ss2.config = Object.assign({}, config,  {dns: sysManager.myDefaultDns()});
    await ss2.start();
    this.ready = true;

    // if(options.booting) { // no need to apply when booting, it will be taken care of by system:policy or device policy  
    //   return;
    // }

    await this.applySS2();
    for (const macAddress in this.enabledMacAddresses) {
      await this.applyDeviceSS2(macAddress);
    }
  }

  async applySS2() {
    if (!this.ready) {
      log.info("Service ss2 is not ready.");
      return;
    }

    if (this.systemSwitch && this.adminSystemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async applyDeviceSS2(macAddress) {
    try {
      if (this.enabledMacAddresses[macAddress] && this.adminSystemSwitch) {
        return this.perDeviceStart(macAddress)
      } else {
        return this.perDeviceStop(macAddress);
      }
    } catch (err) {
      log.error(`Failed to apply ss2 on device ${macAddress}, err: ${err}`);
    }
  }

  async systemStart() {
    log.info("Starting SS2 at global level...");
    const entry = `server=${ss2.getLocalServer()}\n`;
    await fs.writeFileAsync(systemConfigFile, entry);
    await dnsmasq.scheduleRestartDNSService();

    await ss2.redirectTraffic();
  }

  async systemStop() {
    log.info("Stopping SS2 at global level...");
    await fs.unlinkAsync(systemConfigFile).catch(() => undefined);
    dnsmasq.scheduleRestartDNSService();

    await ss2.stop();
  }

  async perDeviceStart(macAddress) {
    log.info(`Starting ss2 on device ${macAddress}...`);
    const configFile = `${dnsmasqConfigFolder}/ss2_${macAddress}.conf`;
    const dnsmasqentry = `server=${ss2.getLocalServer()}%${macAddress.toUpperCase()}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStop(macAddress) {
    log.info(`Stopping ss2 on device ${macAddress}...`);
    const configFile = `${dnsmasqConfigFolder}/ss2_${macAddress}.conf`;
    try {
      await fs.unlinkAsync(configFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        log.info(`Dnsmasq: No ${configFile}, skip remove`);
      } else {
        log.warn(`Dnsmasq: Error when remove ${configFile}`, err);
      }
    }
    dnsmasq.scheduleRestartDNSService();
  }

  // global on/off
  async globalOn(options) {
    this.adminSystemSwitch = true;
    await this.applyAll(options);
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    //await this.applyAll();
    await ss2.stop();
    await this.applySS2();
    for (const macAddress in this.enabledMacAddresses) {
      await this.applyDeviceSS2(macAddress);
    }
  }

  async apiRun() {
    if(platform.getName() !== 'gold') {
      return;
    }
  }
}

module.exports = SS2Plugin;
