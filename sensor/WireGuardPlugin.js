/*    Copyright 2021-2023 Firewalla Inc.
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
const HostManager = require('../net2/HostManager.js');
const hostManager= new HostManager();
const Message = require('../net2/Message.js');
const pclient = require('../util/redis_manager.js').getPublishClient();

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const featureName = "wireguard";

const wireguard = require('../extension/wireguard/wireguard.js');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

class WireGuardPlugin extends Sensor {
  async run() {
    // Firewalla-managed Wireguard is only available on Navy currently, Wireguard on Gold is managed by FireRouter
    if(platform.getName() !== 'navy') {
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

    sem.on(Message.MSG_WG_PEER_REFRESHED, (event) => {
      this.applyWireGuard();
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
        const config = {};
        if (!policy.listenPort)
          policy.listenPort = this.generateRandomListenPort();
        if (!policy.subnet)
          policy.subnet = this.generateRandomSubnet();
        if (!policy.intf)
          policy.intf = "wg0";
        if (!policy.privateKey) {
          const privateKey = await this.generatePrivateKey();
          policy.privateKey = privateKey;
        }
        policy.publicKey = await this.generatePublicKey(policy.privateKey);

        config.listenPort = policy.listenPort;
        config.subnet = policy.subnet;
        config.intf = policy.intf;
        config.privateKey = policy.privateKey;
        wireguard.setConfig(config);
        await this.applyWireGuard();
        await hostManager.setPolicyAsync(featureName, policy);
        pclient.publishAsync(Message.MSG_WG_SUBNET_CHANGED, config.subnet);
      }
    } catch (err) {
      log.error("Got error when applying doh policy", err);
    }
  }

  async generatePrivateKey() {
    const privateKey = await exec("wg genkey").then(result => result.stdout.trim()).catch((err) => {
      log.error("Failed to generate private key", err.message);
      return null;
    });
    return privateKey;
  }

  async generatePublicKey(privateKey) {
    const publicKey = privateKey && await exec(`echo ${privateKey} | wg pubkey`).then(result => result.stdout.trim()).catch((err) => {
      log.error("Failed to generate public key", err.message);
      return null;
    });
    return publicKey;
  }

  generateRandomSubnet() {
    while (true) {
      // random segment from 20 to 199
      const seg1 = Math.floor(Math.random() * 180 + 20);
      const seg2 = Math.floor(Math.random() * 180 + 20);
      if (!sysManager.inMySubnets4(`10.${seg1}.${seg2}.1`))
        return "10." + seg1 + "." + seg2 + ".0/24";
    }
  }

  generateRandomListenPort() {
    return 30000 + Math.floor(Math.random() * 10000);
  }

  async applyWireGuard() {
    if (this.systemSwitch && this.adminSystemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async systemStart() {
    return wireguard.restart();
  }

  async systemStop() {
    return wireguard.stop();
  } 

  // global on/off
  async globalOn() {
    this.adminSystemSwitch = true;
    await this.applyWireGuard();
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    await this.applyWireGuard();
  }

  async apiRun() {
    // Firewalla-managed Wireguard is only available on Navy currently, Wireguard on Gold is managed by FireRouter
    if(platform.getName() !== 'navy') {
      return;
    }

    extensionManager.onGet("wireguard.getAllConfig", async () => {
      const policy = await hostManager.loadPolicyAsync();
      if (policy && policy[featureName])
        wireguard.setConfig(policy[featureName]);
      const config = wireguard.getConfig();
      const configCopy = JSON.parse(JSON.stringify(config));
      delete configCopy.privateKey; // no need to keep private key
      const peerConfig = await wireguard.getPeers();
      return {config, peerConfig};
    });

    extensionManager.onGet("wireguard.getPeers", async (msg) => {
      return wireguard.getPeers();
    });

    extensionManager.onCmd("wireguard.createPeer", async (msg, data) => {
      const policy = await hostManager.loadPolicyAsync();
      if (policy && policy[featureName])
        wireguard.setConfig(policy[featureName]);
      await wireguard.createPeer(data);
      const event = {
        type: Message.MSG_WG_PEER_REFRESHED,
        message: "Wireguard peers are refreshed"
      };
      sem.sendEventToAll(event);
    });

    extensionManager.onCmd("wireguard.setPeers", async (msg, data) => {
      const policy = await hostManager.loadPolicyAsync();
      if (policy && policy[featureName])
        wireguard.setConfig(policy[featureName]);
      await wireguard.setPeers(data.peerConfig || []);
      const event = {
        type: Message.MSG_WG_PEER_REFRESHED,
        message: "Wireguard peers are refreshed"
      };
      sem.sendEventToAll(event);
    })
  }
}

module.exports = WireGuardPlugin;
 
