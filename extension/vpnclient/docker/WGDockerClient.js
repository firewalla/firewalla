/*    Copyright 2016 - 2021 Firewalla Inc 
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

const log = require('../../../net2/logger.js')(__filename);
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const DockerBaseVPNClient = require('./DockerBaseVPNClient.js');
const YAML = require('../../../vendor_lib/yaml/dist');
const _ = require('lodash');

// this is a dummy implementation to demo the usage of DockerBaseVPNClient. It is not intended for production use. We should maintain our own docker containers and repository
const yamlJson = {
  "version": "2",
  "services": {
    "vpn": {
      "image": "cmulk/wireguard-docker:alpine",
      "privileged": true,
      "volumes": [
        "./wg0.conf:/etc/wireguard/wg0.conf"
      ],
      "networks": [
        "default"
      ],
      "cap_add": [
        "NET_ADMIN",
        "SYS_MODULE"
      ],
    }
  },
  "networks": {
    "default": {
    }
  }
}

class WGDockerClient extends DockerBaseVPNClient {

  static convertPlainTextToJson(content) {
    let addresses = [];
    let dns = []
    const peers = [];
    const config = {};
    const lines = content.split("\n");
    let peer = null;
    let currentSection = null;
    for (const line of lines) {
      if (line === "[Interface]" || line === "[Peer]") {
        if (line === "[Peer]") {
          // use 20 seconds as default persistentKeepalive value
          peer = {persistentKeepalive: 20};
          peers.push(peer);
        }
        currentSection = line;
        continue;
      }
      if (!line.includes('='))
        continue;
      const key = line.substring(0, line.indexOf('=')).trim();
      const value = line.substring(line.indexOf('=') + 1).trim();
      switch (currentSection) {
        case "[Interface]": {
          if (key === "Address")
            addresses = addresses.concat(value.split(',').map(v => v.trim()));
          if (key === "PrivateKey")
            config.privateKey = value;
          if (key === "DNS")
            dns = dns.concat(value.split(',').map(v => v.trim()));
          if (key === "MTU")
            config.mtu = value;
          break;
        }
        case "[Peer]": {
          if (key === "PublicKey")
            peer.publicKey = value;
          if (key === "Endpoint")
            peer.endpoint = value;
          if (key === "AllowedIPs")
            peer.allowedIPs = value.split(',').map(v => v.trim());
          if (key === "PresharedKey")
            peer.presharedKey = value;
          if (key === "PersistentKeepalive")
            peer.persistentKeepalive = value;
          break;
        }
        default:
      }
    }
    config.addresses = addresses;
    config.dns = dns;
    config.peers = peers;
    return config;
  }

  async _generateConfig() {
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    if (!config)
      return;
    const entries = [];
    entries.push(`[Interface]`);
    const privateKey = config.privateKey;
    entries.push(`PrivateKey = ${privateKey}`);
    const addresses = config.addresses || [];
    if (addresses.length > 0)
      entries.push(`Address = ${addresses.join(',')}`);
    if (config.mtu)
      entries.push(`MTU = ${config.mtu}`);
    const dns = config.dns || [];
    if (dns.length > 0)
      entries.push(`DNS = ${dns.join(',')}`);
    const peers = config.peers || [];
    for (const peer of peers) {
      entries.push(`[Peer]`);
      for (const key of Object.keys(peer)) {
        const value = peer[key];
        switch (key) {
          case "publicKey":
            entries.push(`PublicKey = ${value}`);
            break;
          case "endpoint":
            entries.push(`Endpoint = ${value}`);
            break;
          case "allowedIPs":
            entries.push(`AllowedIPs = ${value.join(',')}`);
            break;
          case "presharedKey":
            entries.push(`PresharedKey = ${value}`);
            break;
          case "persistentKeepalive":
            entries.push(`PersistentKeepalive = ${value}`);
            break;
          default:
        }
      }
    }
    await fs.writeFileAsync(`${this._getDockerConfigDirectory()}/wg0.conf`, entries.join('\n'), {encoding: 'utf8'});
  }

  async checkAndSaveProfile(value) {
    const content = value.content;
    let config = value.config || {};
    if (content) {
      const convertedConfig = WGDockerClient.convertPlainTextToJson(content);
      config = Object.assign({}, convertedConfig, config);
    }
    if (Object.keys(config).length === 0) {
      throw new Error("either 'config' or 'content' should be specified");
    }
    await this.saveJSONConfig(config).catch((err) => {
      log.error(`Failed to save config for wg docker client ${this.profileId}`, err.message);
    });
  }

  async __prepareAssets() {
    // a dummy implementation to directly write docker-compose.yaml from hard-coded config
    await fs.writeFileAsync(`${this._getDockerConfigDirectory()}/docker-compose.yaml`, YAML.stringify(yamlJson), {encoding: "utf8"});
    await this._generateConfig();
  }

  async _getDNSServers() {
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    return config && config.dns || [];
  }

  async getRoutedSubnets() {
    const subnets = await super.getRoutedSubnets() || [];
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    const peers = config && config.peers;
    if (_.isArray(peers)) {
      for (const peer of peers) {
        if (_.isArray(peer.allowedIPs))
          Array.prototype.push.apply(subnets, peer.allowedIPs);
      }
    }
    return _.uniq(subnets);
  }

  // use same directory as WGVPNClient.js, so that different implementations for the same protocol can be interchanged
  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/wg_profile`;
  }

  static getProtocol() {
    return "wireguard";
  }

  static getKeyNameForInit() {
    return "wgvpnClientProfiles";
  }
}

module.exports = WGDockerClient;
