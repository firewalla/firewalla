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

const log = require('../../net2/logger.js')(__filename);
const fs = require('fs');
const f = require('../../net2/Firewalla.js');
const VPNClient = require('./VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');

class WGVPNClient extends VPNClient {

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

  async getVpnIP4s() {
    let config = null;
    try {
      config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content));
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    return (config && config.addresses || []).filter(ip => new Address4(ip).isValid());
  }

  getProtocol() {
    return "wireguard";
  }

  _getConfigPath() {
    return `${f.getHiddenFolder()}/run/wg_profile/${this.profileId}.conf`;
  }

  _getSettingsPath() {
    return `${f.getHiddenFolder()}/run/wg_profile/${this.profileId}.settings`;
  }

  _getJSONConfigPath() {
    return `${f.getHiddenFolder()}/run/wg_profile/${this.profileId}.json`;
  }

  async _generateConfig() {
    let config = null;
    try {
      config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content));
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    if (!config)
      return;
    const entries = [];
    entries.push(`[Interface]`);
    const privateKey = config.privateKey;
    entries.push(`PrivateKey = ${privateKey}`);
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
    await fs.writeFileAsync(this._getConfigPath(), entries.join('\n'), {encoding: 'utf8'});
  }

  async _getDNSServers() {
    let config = null;
    try {
      config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content));
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    return config && config.dns || [];
  }

  async _start() {
    await this._generateConfig();
    const intf = this.getInterfaceName();
    await exec(`sudo ip link add dev ${intf} type wireguard`).catch((err) => {
      log.error(`Failed to create wireguard interface ${intf}`, err.message);
    });
    await exec(`sudo ip link set ${intf} up`).catch((err) => {});
    await exec(`sudo ip addr flush dev ${intf}`).catch((err) => {});
    await exec(`sudo ip -6 addr flush dev ${intf}`).catch((err) => {});
    await exec(`sudo wg setconf ${intf} ${this._getConfigPath()}`).catch((err) => {
      log.error(`Failed to set interface config ${this._getConfigPath()} on ${intf}`, err.message);
    });
    let config = null;
    try {
      config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content));
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    const mtu = (config && config.mtu) || 1412;
    await exec(`sudo ip link set ${intf} mtu ${mtu}`);
    const addresses = config.addresses || [];
    for (const addr of addresses) {
      if (new Address4(addr).isValid()) {
        await exec(`sudo ip addr add ${addr} dev ${intf}`).catch((err) => {});
      } else {
        if (new Address6(addr).isValid()) {
          await exec(`sudo ip -6 addr add ${addr} dev ${intf}`).catch((err) => {});
        }
      }
    }
  }

  async _stop() {
    const intf = this.getInterfaceName();
    await exec(`sudo ip link set ${intf} down`).catch((err) => {});
    await exec(`sudo ip link del dev ${intf}`).catch((err) => {});
  }

  async checkAndSaveProfile(value) {
    const content = value.content;
    let config = value.config || {};
    if (content) {
      // merge JSON config and plain text config file together, JSON config takes higher precedence
      const convertedConfig = WGVPNClient.convertPlainTextToJson(content);
      config = Object.assign({}, convertedConfig, config);
    }
    if (Object.keys(config).length === 0) {
      throw new Error("either 'config' or 'content' should be specified");
    }
    await fs.writeFileAsync(this._getJSONConfigPath(), JSON.stringify(config), {encoding: "utf8"});
  }

  async _isLinkUp() {
    const intf = this.getInterfaceName();
    const intfUp = await exec(`ip link show dev ${intf}`).then(() => true).catch((err) => false);
    if (!intfUp)
      return false;
    // if any peer's latest handshake happens no more than 2 minutes ago, consider as connected
    let config = null;
    try {
      config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content));
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
      return false;
    }
    const handshakeDetected = await exec(`sudo wg show ${intf} latest-handshakes`).then(result => result.stdout.trim().split('\n').some(line => {
      const [pubKey, handshakeTimestamp] = line.split('\t');
      const peer = config && config.peers.find(p => p.publicKey === pubKey);
      // consider as connected if latest handshake happens no more than (120 + 2 x persistentKeepalive) seconds ago
      // 120 seconds is wireguard's REKEY_AFTER_TIME: https://github.com/WireGuard/wireguard-monolithic-historical/blob/master/src/messages.h#L45
      if (peer && Date.now() / 1000 < Number(handshakeTimestamp) + 120 + Number(peer.persistentKeepalive) * 2)
        return true;
      return false;
    })).catch((err) => {
      log.error(`Failed to check latest-handshakes of ${intf}`, err.message);
      return true;
    });
    return handshakeDetected;
  }

  async destroy() {
    await super.destroy();
    const filesToDelete = [this._getConfigPath(), this._getSettingsPath(), this._getJSONConfigPath()];
    for (const file of filesToDelete)
      await fs.unlinkAsync(file).catch((err) => {});
  }

  static async listProfileIds() {
    const dirPath = f.getHiddenFolder() + "/run/wg_profile";
    const files = await fs.readdirAsync(dirPath);
    const profileIds = files.filter(filename => filename.endsWith('.settings')).map(filename => filename.slice(0, filename.length - 9));
    return profileIds;
  }

  async getAttributes(includeContent = false) {
    const attributes = await super.getAttributes();
    try {
      const config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content));
      attributes.config = config;
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    attributes.type = "wireguard";
    return attributes;
  }
}

module.exports = WGVPNClient;