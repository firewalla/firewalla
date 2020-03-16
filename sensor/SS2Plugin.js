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
const systemConfigFile = `${dnsmasqConfigFolder}/doh_system.conf`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const dnsTag = "$doh";
const systemLevelMac = "FF:FF:FF:FF:FF:FF";

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const fc = require('../net2/config.js');

const spt = require('../net2/SystemPolicyTool')();
const rclient = require('../util/redis_manager.js').getRedisClient();

const featureName = "ss2";

const ss2 = require('../extension/ss2/ss2.js');

class SS2Plugin extends Sensor {
  async run() {
    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.enabledMacAddresses = {};

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });
    
    await exec(`mkdir -p ${dnsmasqConfigFolder}`);

    this.hookFeature(featureName);

    sem.on('SS2_REFRESH', (event) => {
      this.applyAll();
    });
  }

  async job() {
    fc.isFeatureOn(featureName) && (await this.applyAll(true));
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

  async applyAll() {
    await ss2.start({dns: sysManager.myDefaultDns()});
    await this.applySS2();
    for (const macAddress in this.enabledMacAddresses) {
      await this.applyDeviceSS2(macAddress);
    }
  }

  async applySS2() {
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
    const entry = `server=${ss2.getLocalServer()}\n`;
    await fs.writeFileAsync(systemConfigFile, entry);
    await dnsmasq.restartDnsmasq();

    const config = await ss2.getConfig();
    await ss2.redirectTraffic(config);
  }

  async systemStop() {
    await fs.unlinkAsync(systemConfigFile).catch(() => undefined);
    await dnsmasq.restartDnsmasq();
  }

  async perDeviceStart(macAddress) {
    log.info(`Starting ss2 on device ${macAddress}...`);
    const configFile = `${dnsmasqConfigFolder}/doh_${macAddress}.conf`;
    const dnsmasqentry = `server=${ss2.getLocalServer()}%${macAddress.toUpperCase()}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.restartDnsmasq();
  }

  async perDeviceStop(macAddress) {
    log.info(`Stopping ss2 on device ${macAddress}...`);
    const configFile = `${dnsmasqConfigFolder}/doh_${macAddress}.conf`;
    try {
      await fs.unlinkAsync(configFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        log.info(`Dnsmasq: No ${configFile}, skip remove`);
      } else {
        log.warn(`Dnsmasq: Error when remove ${configFile}`, err);
      }
    }
    dnsmasq.restartDnsmasq();
  }

  // global on/off
  async globalOn() {
    this.adminSystemSwitch = true;
    await this.applyAll();
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
    extensionManager.onSet("ss2Config", async (msg, data) => {
      if(data) {
        await ss2.setConfig(data);
        sem.sendEventToFireMain({
          type: 'SS2_REFRESH'
        });
      }
    });

    extensionManager.onGet("ss2Config", async (msg, data) => {
      return ss2.getConfig();
    });
  }
}

module.exports = SS2Plugin;
