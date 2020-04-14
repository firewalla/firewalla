/*    Copyright 2019-2020 Firewalla Inc.
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

const sem = require('../../sensor/SensorEventManager.js').getInstance();

const rclient = require('../../util/redis_manager').getRedisClient();

const _ = require('lodash');

const wrapIptables = require('../../net2/Iptables.js').wrapIptables;

const exec = require('child-process-promise').exec;

const f = require('../../net2/Firewalla.js');

const sharedPeerConfigKey = "ext.wireguard.peers.config";

const sysManager = require('../../net2/SysManager.js')
const firerouter = require('../../net2/FireRouter.js')

const intf = "wg0";

const fs = require('fs');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

class WireGuard {
  constructor() {
    if (instance === null) {
      instance = this;
      this.config = {};
      this.ready = false;
    }
    return instance;
  }

  async randomServerConfig() {
    const privateKey = (await exec("wg genkey")).stdout.replace("\n", "");
    const publicKey = (await exec(`echo ${privateKey} | wg pubkey`)).stdout.replace("\n", "");
    const listenPort = 30000 + Math.floor(Math.random() * 10000);
    const networkNumber = Math.floor(Math.random() * 256);
    const localNet = `10.1.${networkNumber}.0/24`;
    const localAddressCIDR = `10.1.${networkNumber}.1/24`;
    return {
      privateKey, publicKey, listenPort, localNet, intf, localAddressCIDR
    };
  }

  async isAddressUsed(address) {
    const peers = await this.getAllPeers();
    const matchedPeers = peers.filter((peer) => {
      return peer.localAddress === address;
    });
    return !_.isEmpty(matchedPeers);
  }


  async findAvailableLocalAddress() {
    for(var i = 0; i < 100; i++) {
      const localAddress = `10.1.0.${Math.floor(Math.random()*253) + 2}/24`;
      
      const used = await this.isAddressUsed(localAddress);

      if(!used) {
        return localAddress;
      }
    }

    return null;
  }

  async getConfig() {
    const redisConfig = await rclient.hgetAsync("sys:features:config", "wireguard");
    if (redisConfig) {
      try {
        return JSON.parse(redisConfig);
      } catch (err) {
        log.error("Got error when parsing wg config, err:", err);
        return null;
      }
    } else {
      const config = await this.randomServerConfig();
      await rclient.hsetAsync("sys:features:config", "wireguard", JSON.stringify(config));
      return config;
    }
  }

  async createPeer(data) {
    const peerConfig = {};
    peerConfig.publicKey = data.publicKey;
    peerConfig.localAddress = await this.findAvailableLocalAddress()
    peerConfig.id = data.id;
    peerConfig.name = data.name;    
    await rclient.saddAsync(sharedPeerConfigKey, JSON.stringify(peerConfig));
    const config = await this.getConfig();
    await this.addPeer(config, peerConfig);
  }

  async getAllPeers() {
    const configs = [];
    const peers = await rclient.smembersAsync(sharedPeerConfigKey);
    for(const peer of peers) {
      try {
        const peerConfig = JSON.parse(peer);
        configs.push(peerConfig);
      } catch(err) {
        log.error("Failed to parse config, err:", err);        
      }
    }

    return configs;
  }

  async getPeer(id) {
    const peers = await rclient.smembersAsync(sharedPeerConfigKey);
    for(const peer of peers) {
      try {
        const peerConfig = JSON.parse(peer);
        if(peerConfig && peerConfig.id === id) {
          return peerConfig;
        }
      } catch(err) {
        log.error("Failed to parse config, err:", err);        
      }
    }
  }

  async start() {
    const config = await this.getConfig();
    log.info(`Starting wireguard on interface ${config.intf}`);
//    log.info("Config is", config);
    await exec(`sudo ip link add dev ${config.intf} type wireguard`).catch(() => undefined);
    await exec(`sudo wg set ${config.intf} listen-port ${config.listenPort}`);
    const privateKeyLocation = `/etc/wireguard/${config.intf}.privateKey`;
    await exec(`echo ${config.privateKey} | sudo bash -c 'cat > ${privateKeyLocation}'`);
    await exec(`sudo wg set ${config.intf} private-key ${privateKeyLocation}`);
    await exec(`sudo ip addr add ${config.localAddressCIDR} dev ${config.intf}`).catch(() => undefined);
    await exec(`sudo ip link set up dev ${config.intf}`).catch(() => undefined);
    await exec(wrapIptables(`sudo iptables -t nat -A POSTROUTING -s ${config.localAddressCIDR} -o ${firerouter.getDefaultWanIntfName()} -j MASQUERADE`)).catch(() => undefined);
    await exec(`sudo ip rule del from all iif ${config.intf} lookup global_default priority 10001`).catch(() => undefined);
    await exec(`sudo ip rule add from all iif ${config.intf} lookup global_default priority 10001`).catch(() => undefined);
    await exec(`sudo ip route add ${config.localNet} dev ${config.intf} table lan_routable`).catch(() => undefined)
    await exec(`sudo ip route add ${config.localNet} dev ${config.intf} table wan_routable`).catch(() => undefined);
    await exec(`sudo ip rule del from all iif ${config.intf} lookup lan_routable priority 5002`).catch(() => undefined);
    await exec(`sudo ip rule add from all iif ${config.intf} lookup lan_routable priority 5002`).catch(() => undefined);

    // FIXME: should support in FireRouter
    const ipsetName = `c_net_vpn-${config.intf}_set`;
    await exec(`sudo ipset create -! ${ipsetName} hash:net,iface maxelem 1024`).catch((err) => undefined);
    await exec(`sudo ipset add -! ${ipsetName} 10.1.0.0/24,wg0`)
    await exec(`sudo ipset add -! monitored_net_set ${ipsetName}`);

    await this.addPeers().catch(() => undefined);
    log.info(`Wireguard ${config.intf} is started successfully.`);
  }
  
  async addPeers() {
    const config = await this.getConfig();
    const peers = await rclient.smembersAsync(sharedPeerConfigKey);
    for (const peer of peers) {
      try {
        const peerConfig = JSON.parse(peer);
        await this.addPeer(config, peerConfig);
      } catch (err) {
        log.error("Got error when parsing peerConfig, err:", peer);
      }
    }
  }

  async addPeer(config, peerConfig) {
    if(!peerConfig.localAddress) {
      return;
    }

    const pubKey = peerConfig && peerConfig.publicKey;
    if (pubKey) {
      log.info(`Adding Peer ${pubKey}...`);
      const localIP = peerConfig && peerConfig.localAddress && peerConfig.localAddress.replace("/24", "/32")
      await exec(`sudo wg set ${config.intf} peer ${pubKey} allowed-ips ${localIP}`).catch((err) => {
        log.error("Got error when adding peer to wg, err:", err);
      });
    }
  }

  async stop() {
    const config = await this.getConfig();
    log.info(`Stopping wireguard ${config.intf}...`);
    await exec(`sudo ip rule del from all iif ${config.intf} lookup wan_routable`).catch(() => undefined);
    await exec(`sudo iptables -t nat -D POSTROUTING -o ${firerouter.getDefaultWanIntfName()} -j MASQUERADE`).catch(() => undefined);
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
