/*    Copyright 2021-2022 Firewalla Inc.
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

const log = require('../logger.js')(__filename);
const sysManager = require('../SysManager.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const rclient = require('../../util/redis_manager.js').getRedisClient();

const Constants = require('../Constants.js');
const NetworkProfile = require('../NetworkProfile.js');
const Message = require('../Message.js');
const FireRouter = require('../FireRouter.js');
const exec = require('child-process-promise').exec;

const wgPeers = {};

const Identity = require('../Identity.js');
const _ = require('lodash');

const privPubKeyMap = {};

class WGPeer extends Identity {
  static isAddressInRedis() {
    // IP address of WireGuard peer is statically configured, no need to use redis for dynamic update
    return false;
  }

  getUniqueId() {
    return this.o && this.o.publicKey;
  }

  static isEnabled() {
    return platform.isWireguardSupported();
  }

  static getNamespace() {
    return Constants.NS_WG_PEER;
  }

  static getKeyOfUIDInAlarm() {
    return "p.device.wgPeer";
  }

  static getKeyOfInitData() {
    return "wgPeers";
  }

  static async getInitData() {
    const hash = await super.getInitData();
    const hashCopy = JSON.parse(JSON.stringify(hash));
    const peers = [];
    let intfs = [];
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      if (networkConfig && networkConfig.interface && networkConfig.interface.wireguard) {
        intfs = Object.keys(networkConfig.interface.wireguard);
      }
    } else {
      intfs.push("wg0");
    }
    for (const intf of intfs) {
      const dumpResult = await exec(`sudo wg show ${intf} dump | tail +2`).then(result => result.stdout.trim().split('\n')).catch((err) => {
        log.error(`Failed to dump wireguard peers on ${intf}`, err.message);
        return null;
      });
      if (_.isArray(dumpResult)) {
        for (const line of dumpResult) {
          try {
            const [pubKey, psk, endpoint, allowedIPs, latestHandshake, rxBytes, txBytes, keepalive] = line.split('\t');
            if (pubKey) {
              if (hashCopy.hasOwnProperty(pubKey) && _.isObject(hashCopy[pubKey])) {
                const obj = hashCopy[pubKey];
                obj.uid = pubKey;
                obj.lastActiveTimestamp = !isNaN(latestHandshake) && Number(latestHandshake) || null;
                if (endpoint !== "(none)")
                  obj.endpoint = endpoint;
                obj.rxBytes = !isNaN(rxBytes) && Number(rxBytes) || 0;
                obj.txBytes = !isNaN(rxBytes) && Number(txBytes) || 0;
              } else {
                log.error(`Unknown peer public key: ${pubKey}`);
              }
            }
          } catch (err) {
            log.error(`Failed to parse dump result ${line}`, err.message);
          }
        }
      }
    }
    
    const IntelTool = require('../IntelTool.js');
    const IntelManager = require('../IntelManager.js');
    const intelTool = new IntelTool();
    const intelManager = new IntelManager();
    await Promise.all(Object.keys(hashCopy).map(async (pubKey) => {
      const obj = hashCopy[pubKey];
      if (obj.endpoint) {
        const endpointIp = obj.endpoint.startsWith("[") && obj.endpoint.includes("]:") ? obj.endpoint.substring(1, obj.endpoint.indexOf("]:")) : obj.endpoint.split(':')[0];
        const intel = await intelTool.getIntel(endpointIp);
        const loc = await intelManager.ipinfo(endpointIp, true);
        obj.country = (intel && intel.country) || (loc && loc.country) || undefined;
        if (intel && intel.latitude && intel.longitude) {
          obj.latitude = intel.latitude;
          obj.longitude = intel.longitude;
        } else {
          if (loc && loc.loc) {
            const ll = loc.loc.split(",");
            if (ll.length === 2) {
              obj.latitude = parseFloat(ll[0]);
              obj.longitude = parseFloat(ll[1]);
            }
          }
        }
      }
      peers.push(obj);
    }))
    return peers;
  }

  static getDnsmasqConfigFilenamePrefix(uid) {
    return super.getDnsmasqConfigFilenamePrefix(uid.replace(/\//g, "_"));
  }

  getDnsmasqConfigDirectory() {
    if (platform.isFireRouterManaged()) {
      const vpnIntfUUID = this.getNicUUID();
      if (vpnIntfUUID && sysManager.getInterfaceViaUUID(vpnIntfUUID)) {
        return `${NetworkProfile.getDnsmasqConfigDirectory(vpnIntfUUID)}`;
      }
    }
    return super.getDnsmasqConfigDirectory();
  }

  static async getIdentities() {
    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      let intfs = [];
      if (networkConfig && networkConfig.interface && networkConfig.interface.wireguard) {
        intfs = Object.keys(networkConfig.interface.wireguard);
      }
      for (const intf of intfs) {
        const peers = networkConfig.interface.wireguard[intf] && networkConfig.interface.wireguard[intf].peers || [];
        const peersExtra = networkConfig.interface.wireguard[intf] && networkConfig.interface.wireguard[intf].extra && networkConfig.interface.wireguard[intf].extra.peers || [];
        for (const peer of peers) {
          const pubKey = peer.publicKey;
          const allowedIPs = peer.allowedIPs;
          result[pubKey] = {
            intf: intf,
            publicKey: pubKey,
            allowedIPs: allowedIPs
          };
        }
        for (const peerExtra of peersExtra) {
          const name = peerExtra.name;
          const privateKey = peerExtra.privateKey;
          const pubKey = privPubKeyMap[privateKey] || await exec(`echo ${privateKey} | wg pubkey`).then(result => result.stdout.trim()).catch((err) => {
            log.error(`Failed to calculate public key from private key ${privateKey}`, err.message);
            return null;
          });
          if (pubKey) {
            privPubKeyMap[privateKey] = pubKey;
            if (result[pubKey])
              result[pubKey].name = name;
          }
        }
      }
    } else {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        peer.intf = "wg0";
        const pubKey = peer.publicKey;
        result[pubKey] = peer;
      }
    }

    for (const pubKey of Object.keys(wgPeers))
      wgPeers[pubKey].active = false;

    for (const pubKey of Object.keys(result)) {
      const o = result[pubKey];
      o.publicKey = pubKey;
      if (wgPeers[pubKey])
        await wgPeers[pubKey].update(o);
      else
        wgPeers[pubKey] = new WGPeer(o);
      wgPeers[pubKey].active = true;
    }

    for (const pubKey of Object.keys(wgPeers)) {
      if (wgPeers[pubKey].active === false) {
        delete wgPeers[pubKey]
        continue
      }

      const redisMeta = await rclient.hgetallAsync(wgPeers[pubKey].getMetaKey())
      Object.assign(wgPeers[pubKey].o, WGPeer.parse(redisMeta))
    }
    return wgPeers;
  }

  static async getIPUniqueIdMappings() {
    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      let intfs = [];
      if (networkConfig && networkConfig.interface && networkConfig.interface.wireguard) {
        intfs = Object.keys(networkConfig.interface.wireguard);
      }
      for (const intf of intfs) {
        const peers = networkConfig.interface.wireguard[intf] && networkConfig.interface.wireguard[intf].peers || [];
        for (const peer of peers) {
          const pubKey = peer.publicKey;
          const allowedIPs = peer.allowedIPs || [];
          for (const ip of allowedIPs) {
            result[ip] = pubKey;
          }
        }
      }
    } else {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          result[ip] = pubKey;
        }
      }
    }
    return result;
  }

  static async getIPEndpointMappings() {
    const pubKeyEndpointMap = {};
    let intfs = [];
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      if (networkConfig && networkConfig.interface && networkConfig.interface.wireguard) {
        intfs = Object.keys(networkConfig.interface.wireguard);
      }
    } else
      intfs.push("wg0");
    for (const intf of intfs) {
      const endpointsResults = (await exec(`sudo wg show ${intf} endpoints`).then(result => result.stdout.trim().split('\n')).catch((err) => {
        log.debug(`Failed to show endpoints using wg command`, err.message);
        return [];
      })).map(result => result.split(/\s+/g));
      for (const endpointResult of endpointsResults) {
        const pubKey = endpointResult[0];
        const endpoint = endpointResult[1];
        if (pubKey && endpoint)
          pubKeyEndpointMap[pubKey] = endpoint;
      }
    }

    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      for (const intf of intfs) {
        const peers = networkConfig.interface.wireguard[intf] && networkConfig.interface.wireguard[intf].peers || [];
        for (const peer of peers) {
          const pubKey = peer.publicKey;
          const allowedIPs = peer.allowedIPs || [];
          for (const ip of allowedIPs) {
            if (pubKeyEndpointMap[pubKey])
              result[ip] = pubKeyEndpointMap[pubKey];
          }
        }
      }
    } else {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          if (pubKeyEndpointMap[pubKey])
            result[ip] = pubKeyEndpointMap[pubKey];
        }
      }
    }
    return result;
  }

  static getRefreshIdentitiesHookEvents() {
    return [Message.MSG_SYS_NETWORK_INFO_RELOADED, Message.MSG_WG_PEER_REFRESHED];
  }

  static getRefreshIPMappingsHookEvents() {
    return [Message.MSG_WG_CONN_ACCEPTED];
  }

  getLocalizedNotificationKeySuffix() {
    return ".wgvpn";
  }

  getReadableName() {
    return this.o && this.o.name || this.getUniqueId();
  }

  getNicName() {
    return this.o.intf;
  }
}

module.exports = WGPeer;
