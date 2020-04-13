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
const systemConfigFile = `${dnsmasqConfigFolder}/pihole_system.conf`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const fc = require('../net2/config.js');

const featureName = "pihole";

const pihole = require('../extension/pihole/pihole.js');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class PiHolePlugin extends Sensor {
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
  }

  async job() {
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying pihole policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state === true) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applyPiHole();
      } else {
        const macAddress = host && host.o && host.o.mac;
        if (macAddress) {
          if (policy && policy.state === true) {
            this.enabledMacAddresses[macAddress] = 1;
          } else {
            delete this.enabledMacAddresses[macAddress];
          }
          return this.applyDevicePiHole(macAddress);
        }
      }
    } catch (err) {
      log.error("Got error when applying doh policy", err);
    }
  }

  async applyAll(options = {}) {
    log.info("Applying...");
    const config = await this.getFeatureConfig();
    pihole.config = Object.assign({}, config,  {dns: sysManager.myDefaultDns()});
    await pihole.start();
    this.ready = true;

    await this.applyPiHole();
    for (const macAddress in this.enabledMacAddresses) {
      await this.applyDevicePiHole(macAddress);
    }
  }

  async applyPiHole() {
    if (!this.ready) {
      log.info("Service pihole is not ready.");
      return;
    }

    if (this.systemSwitch && this.adminSystemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async applyDevicePiHole(macAddress) {
    try {
      if (this.enabledMacAddresses[macAddress] && this.adminSystemSwitch) {
        return this.perDeviceStart(macAddress)
      } else {
        return this.perDeviceStop(macAddress);
      }
    } catch (err) {
      log.error(`Failed to apply pihole on device ${macAddress}, err: ${err}`);
    }
  }

  async systemStart() {
    log.info("Starting pihole at global level...");
    const entry = `server=127.0.0.1#${pihole.getUDPPort()}\n`;
    await fs.writeFileAsync(systemConfigFile, entry);
    await dnsmasq.scheduleRestartDNSService();
  }

  async systemStop() {
    log.info("Stopping pihole at global level...");
    await fs.unlinkAsync(systemConfigFile).catch(() => undefined);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStart(macAddress) {
    log.info(`Starting pihole on device ${macAddress}...`);
    const configFile = `${dnsmasqConfigFolder}/pihole_${macAddress}.conf`;
    const dnsmasqentry = `server=127.0.0.1#${pihole.getUDPPort()}%${macAddress.toUpperCase()}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStop(macAddress) {
    log.info(`Stopping pihole on device ${macAddress}...`);
    const configFile = `${dnsmasqConfigFolder}/pihole_${macAddress}.conf`;
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
    await pihole.stop();
    await this.applyPiHole();
    for (const macAddress in this.enabledMacAddresses) {
      await this.applyDevicePiHole(macAddress);
    }
  }

  async apiRun() {
    if(platform.getName() !== 'gold') {
      return;
    }
  }
}

module.exports = PiHolePlugin;
