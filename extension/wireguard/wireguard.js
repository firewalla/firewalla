/*    Copyright 2019-2021 Firewalla Inc.
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

let instance = null;

const log = require('../../net2/logger.js')(__filename);

const rclient = require('../../util/redis_manager').getRedisClient();

const _ = require('lodash');

const wrapIptables = require('../../net2/Iptables.js').wrapIptables;

const exec = require('child-process-promise').exec;

const f = require('../../net2/Firewalla.js');

const sharedPeerConfigKey = "ext.wireguard.peer.config";

const fs = require('fs');
const ip = require('ip');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

class WireGuard {
  constructor() {
    if (instance === null) {
      instance = this;
      this.config = {};
    }
    return instance;
  }

  setConfig(config) {
    this.config = config;
  }

  getConfig() {
    return this.config;
  }

  async createPeer(data) {
    const peerConfig = {};
    if (!data.publicKey) {
      log.error("public key is not specified in peer config", data);
      return;
    }
    peerConfig.publicKey = data.publicKey;
    peerConfig.allowedIPs = data.allowedIPs || [];
    peerConfig.name = data.name;    
    await rclient.hsetAsync(sharedPeerConfigKey, data.publicKey, JSON.stringify(peerConfig));
    await this._applyConfig();
  }

  async setPeers(peers) {
    await rclient.delAsync(sharedPeerConfigKey);
    const config = {};
    for (const peer of peers) {
      const pubKey = peer.publicKey;
      if (pubKey) {
        config[pubKey] = JSON.stringify(peer);
      }
    }
    if (Object.keys(config).length !== 0)
      await rclient.hmsetAsync(sharedPeerConfigKey, config);
    await this._applyConfig();
  }

  async getPeers() {
    const configs = [];
    const peers = await rclient.hgetallAsync(sharedPeerConfigKey);
    for(const pubKey in peers) {
      try {
        const peerConfig = JSON.parse(peers[pubKey]);
        configs.push(peerConfig);
      } catch(err) {
        log.error("Failed to parse config, err:", err);        
      }
    }

    return configs;
  }

  async start() {
    const config = this.getConfig();
    if (!config || !config.intf)
      return;
    log.info(`Starting wireguard on interface ${config.intf}`);
    await exec(`sudo ip link add dev ${config.intf} type wireguard`).catch(() => undefined);
    const localAddressCIDR = ip.cidrSubnet(config.subnet).firstAddress + "/" + ip.cidrSubnet(config.subnet).subnetMaskLength;
    await exec(`sudo ip addr replace ${localAddressCIDR} dev ${config.intf}`).catch(() => undefined);
    await exec(`sudo ip link set ${config.intf} mtu ${config.mtu || 1412}`);
    await exec(`sudo ip link set up dev ${config.intf}`).catch(() => undefined);
    await this._applySNATAndRoutes();
    await this._applyConfig();

    log.info(`Wireguard ${config.intf} is started successfully.`);
  }

  async _applySNATAndRoutes() {
    const config = this.getConfig();
    const peers = await this.getPeers();
    await exec(wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING_WIREGUARD -s ${config.subnet} -j MASQUERADE`)).catch(() => {});
    await exec(`sudo ip r add ${config.subnet} dev ${config.intf}`).catch((err) => {});
    for (const peer of peers) {
      const allowedIPs = peer.allowedIPs || [];
      for (const allowedIP of allowedIPs) {
        await exec(`sudo ip r add ${allowedIP} dev ${config.intf}`).catch((err) => {});
      }
    }
  }

  async _applyConfig() {
    const config = this.getConfig();
    const peers = await this.getPeers();
    const entries = ["[Interface]"];
    entries.push(`PrivateKey = ${config.privateKey}`);
    if (config.listenPort)
      entries.push(`ListenPort = ${config.listenPort}`);
    entries.push('\n');
    for (const peer of peers) {
      entries.push("[Peer]");
      entries.push(`PublicKey = ${peer.publicKey}`);
      if (peer.presharedKey) {
        entries.push(`PresharedKey = ${peer.presharedKey}`);
      }
      if (peer.endpoint)
        entries.push(`Endpoint = ${peer.endpoint}`);
      if (peer.allowedIPs && peer.allowedIPs.length !== 0)
        entries.push(`AllowedIPs = ${peer.allowedIPs.join(", ")}`);
      if (peer.persistentKeepalive)
        entries.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
      entries.push('\n');
    }
    await fs.writeFileAsync(`${f.getUserConfigFolder()}/${config.intf}.conf`, entries.join('\n'), {encoding: 'utf8'});
    await exec(`sudo wg setconf ${config.intf} ${f.getUserConfigFolder()}/${config.intf}.conf`).catch((err) => {
      log.error(`Failed to set config on ${config.intf}`, err.message);
    });
  }

  async stop() {
    const config = this.getConfig();
    if (!config || !config.intf)
      return;
    log.info(`Stopping wireguard ${config.intf}...`);
    await exec(wrapIptables(`sudo iptables -w -t nat -F FW_POSTROUTING_WIREGUARD`)).catch(() => undefined);
    await exec(`sudo ip link set down dev ${config.intf}`).catch(() => undefined);
    await exec(`sudo ip link del dev ${config.intf}`).catch(() => undefined);
    log.info(`Wireguard ${config.intf} is stopped successfully.`);
  }

  async restart() {
    await this.stop();
    await this.start();
  }
}

module.exports = new WireGuard();
