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

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const fc = require('../net2/config.js');

const featureName = "wireguard";

const wireguard = require('../extension/wireguard/wireguard.js');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class WireGuardPlugin extends Sensor {
  async run() {
    if(platform.getName() !== 'gold') {
      return;
    }
    
    this.systemSwitch = false;
    this.adminSystemSwitch = false;

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });
      
    this.hookFeature(featureName);

    sem.on('WIREGUARD_REFRESH', (event) => {
      this.applyAll();
    });
    
  }

  async job() {
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying wireguard policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state === true) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applyWireGuard();
      }
    } catch (err) {
      log.error("Got error when applying doh policy", err);
    }
  }

  async applyAll(options = {}) {
    log.info("Applying...");
    const config = await this.getFeatureConfig();
    wireguard.config = Object.assign({}, config,  {dns: sysManager.myDefaultDns()});
    await wireguard.start();
    this.ready = true;

    await this.applyWireGuard();
  }

  async applyWireGuard() {
    if (!this.ready) {
      log.info("Service wireguard is not ready.");
      return;
    }

    if (this.systemSwitch && this.adminSystemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async systemStart() {
    return wireguard.start();
  }

  async systemStop() {
    return wireguard.stop();
  } 

  // global on/off
  async globalOn(options) {
    this.adminSystemSwitch = true;
    await this.applyAll(options);
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    //await this.applyAll();
    await wireguard.stop();
    await this.applyWireGuard();
  }

  async apiRun() {
    if(platform.getName() !== 'gold') {
      return;
    }

    extensionManager.onGet("wireguard.getAllConfig", async () => {
      const config = await wireguard.getConfig();
      const configCopy = JSON.parse(JSON.stringify(config));
      delete configCopy.privateKey; // no need to keep private key
      const peerConfig = await wireguard.getAllPeers();
      return {config, peerConfig};
    });

    extensionManager.onGet("wireguard.getPeers", async (msg) => {
      return wireguard.getAllPeers();
    });

    extensionManager.onCmd("wireguard.createPeer", (msg, data) => {
      return wireguard.createPeer(data);
    });
  }
}

module.exports = WireGuardPlugin;
