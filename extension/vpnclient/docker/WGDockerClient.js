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
const _ = require('lodash');
class WGVPNClient extends VPNClient {
  constructor(options) {
    super(options);
    this.wgCmd = "wg";
  }

  static convertPlainTextToJson(content) {
    let addresses = [];
    let dns = []
    const peers = [];
    const config = {};
    const lines = content.split("\n").map(line => line.trim());
    let peer = null;
    let currentSection = null;
    for (const line of lines) {
      const section = line.toLowerCase();
      if (section === "[interface]" || section === "[peer]") {
        if (section === "[peer]") {
          // use 20 seconds as default persistentKeepalive value
          peer = {persistentKeepalive: 20};
          peers.push(peer);
        }
        currentSection = section;
        continue;
      }
      if (!line.includes('='))
        continue;
      const key = line.substring(0, line.indexOf('=')).trim().toLowerCase();
      const value = line.substring(line.indexOf('=') + 1).trim();
      switch (currentSection) {
        case "[interface]": {
          if (key === "address")
            addresses = addresses.concat(value.split(',').map(v => v.trim()));
          if (key === "privatekey")
            config.privateKey = value;
          if (key === "dns")
            dns = dns.concat(value.split(',').map(v => v.trim())).filter(v => v != '');
          if (key === "mtu")
            config.mtu = value;
          break;
        }
        case "[peer]": {
          if (key === "publickey")
            peer.publicKey = value;
          if (key === "endpoint")
            peer.endpoint = value;
          if (key === "allowedips")
            peer.allowedIPs = value.split(',').map(v => v.trim());
          if (key === "presharedkey")
            peer.presharedKey = value;
          if (key === "persistentkeepalive")
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
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    return (config && config.addresses || []).filter(ip => new Address4(ip).isValid());
  }

  async getVpnIP6s() {
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    return (config && config.addresses || []).filter(ip => new Address6(ip).isValid());
  }

  async getRoutedSubnets() {
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    const peers = config && config.peers;
    const subnets = [];
    if (_.isArray(peers)) {
      for (const peer of peers) {
        if (_.isArray(peer.allowedIPs))
          Array.prototype.push.apply(subnets, peer.allowedIPs);
      }
    }
    return subnets;
  }

  static getProtocol() {
    return "wireguard";
  }

  static getKeyNameForInit() {
    return "wgvpnClientProfiles";
  }

  _getConfigPath() {
    return `${f.getHiddenFolder()}/run/wg_profile/${this.profileId}.conf`;
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
    const fwmark = this.getFwMark();
    if (fwmark)
      entries.push(`FwMark = ${fwmark}`);
    this._addObfuscationOptions(entries, config);
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
            let endpoint = value.trim();
            if (value.includes("firewalla.org") || value.includes("firewalla.com")) {
              const port = value.split(":")[1];
              const ip = await this.resolveFirewallaDDNS(value.split(":")[0]);
              if (ip)
                endpoint = `${ip}${port ? `:${port}` : ""}`;
            }
            entries.push(`Endpoint = ${endpoint}`);
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
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    return config && config.dns || [];
  }

  static getDefaultMTU() {
    return 1412;
  }

  async _start() {
    await this._generateConfig();
    const intf = this.getInterfaceName();
    await exec(`sudo ip link add dev ${intf} type ${this.constructor.getProtocol()}`).catch((err) => {
      log.warn(`Failed to create ${this.constructor.getProtocol()} interface ${intf}`, err.message);
    });
    await exec(`sudo ip link set ${intf} up`).catch((err) => {});
    await exec(`sudo ip addr flush dev ${intf}`).catch((err) => {});
    await exec(`sudo ip -6 addr flush dev ${intf}`).catch((err) => {});
    await exec(`sudo ${this.wgCmd} setconf ${intf} ${this._getConfigPath()}`).catch((err) => {
      log.error(`Failed to set interface config ${this._getConfigPath()} on ${intf}`, err.message);
    });
    await exec(`sudo bash -c 'echo f > /sys/class/net/${intf}/queues/rx-0/rps_cpus'`).catch((err) => {});
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    const mtu = (config && config.mtu) || this.constructor.getDefaultMTU();
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
      const convertedConfig = this.constructor.convertPlainTextToJson(content);
      config = Object.assign({}, convertedConfig, config);
    }
    if (Object.keys(config).length === 0) {
      throw new Error("either 'config' or 'content' should be specified");
    }
    await this.saveJSONConfig(config);
  }

  async _isLinkUp() {
    const intf = this.getInterfaceName();
    const intfUp = await exec(`ip link show dev ${intf}`).then(() => true).catch((err) => false);
    if (!intfUp)
      return false;
    // if any peer's latest handshake happens no more than 2 minutes ago, consider as connected
    let config = null;
    try {
      config = await this.loadJSONConfig();
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
      return false;
    }
    const handshakeDetected = await exec(`sudo ${this.wgCmd} show ${intf} latest-handshakes`).then(result => result.stdout.trim().split('\n').some(line => {
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
    const filesToDelete = [this._getConfigPath()];
    for (const file of filesToDelete)
      await fs.unlinkAsync(file).catch((err) => {});
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/wg_profile`;
  }

  async getRemoteEndpoints() {
    const results = await exec(`sudo ${this.wgCmd} show ${this.getInterfaceName()} endpoints | awk '{print $2}' | grep -v none`).then(result => result.stdout.trim().split('\n')).catch((err) => []);
    const endpoints = [];
    for (const result of results) {
      if (result.startsWith("[") && result.includes("]:")) {
        const ip = result.substring(1, result.indexOf("]:"));
        const port = result.substring(result.indexOf("]:") + 2);
        endpoints.push({ip, port});
      } else {
        const [ip, port] = result.split(':', 2);
        endpoints.push({ip, port});
      }
    }
    return endpoints;
  }

  // return at most last N_SESS sessions
  async getLatestSessionLog() {
    const N_SESS = 3; // retrieve last 3 sessions

    // TODO: make VPNClient.logDir configurable, NEVER defined here
    const logPath = `${this.logDir || "/var/log/wg"}/vpn_${this.profileId}.log`;
    const content = await exec(`sudo tail -n 100 ${logPath}`).then(result => result.stdout.trim()).catch((err) => null);
    if (content) {
      return WGVPNClient._getLastNSession(content, "Interface created", N_SESS);
    }
    return null;
  }

  static _getLastNSession(content, pattern, count) {
    const lines = content.split('\n');
    let beginIdx = -1;
    let hit = 0;
    for (let i=lines.length-1; i >= 0 && hit < count;  i--){
      if (lines[i].includes(pattern)) {
        hit++
        beginIdx = i;
      }
    }
    if (beginIdx >= 0) {
      return lines.slice(beginIdx).join("\n");
    }

    // no pattern found, return last 30 lines of log
    // maybe pattern line failed to sync at startup.
    return lines.slice(Math.max(lines.length-30, 0)).join("\n");
  }

  _addObfuscationOptions(entries, config) {
    // for wireguard, no obfuscation options
  }

  async _getRemoteIP6() {
    //For a Layer 3 tunnel like WireGuard,
    //the kernel doesn't actually care about the specific MAC address of the next hop (because it doesn't need ARP/NDP).
    //It only needs a syntactically valid IP address that conforms to the link specifications
    //to satisfy the "nexthop via..." format requirement.
    // return null;
    return "fe80::1"
  }

}

module.exports = WGVPNClient;            peer.publicKey = value;
          if (key === "endpoint")
            peer.endpoint = value;
          if (key === "allowedips")
            peer.allowedIPs = value.split(',').map(v => v.trim());
          if (key === "presharedkey")
            peer.presharedKey = value;
          if (key === "persistentkeepalive")
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
    const f = require('../../../net2/Firewalla.js');
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
