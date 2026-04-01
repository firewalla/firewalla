/*    Copyright 2021-2024 Firewalla Inc.
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
const asyncNative = require('../../util/asyncNative.js');
const Constants = require('../Constants.js');
const NetworkProfile = require('../NetworkProfile.js');
const Message = require('../Message.js');
const FireRouter = require('../FireRouter.js');
const exec = require('child-process-promise').exec;

const Identity = require('../Identity.js');
const _ = require('lodash');

class WGPeer extends Identity {

  static wgPeers = {};
  static privPubKeyMap = {};
  static wgCmd() {
    return "wg";
  }

  static getProtocol() {
    return "wireguard";
  }

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

  static getRedisKeyVPNWGPeer() {
    return Constants.REDIS_KEY_VPN_WG_PEER;
  }

  static async getInitData() {
    const hash = await super.getInitData();
    const hashCopy = JSON.parse(JSON.stringify(hash));
    const peers = [];
    let intfs = [];
    const protocol = this.getProtocol();
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      if (networkConfig && networkConfig.interface && networkConfig.interface[protocol]) {
        intfs = Object.keys(networkConfig.interface[protocol]);
      }
    } else if (this === WGPeer) {
      intfs.push("wg0");
    }
    await Promise.all(intfs.map(async intf => {
      let autonomousPeerInfo = null;
      if (platform.isFireRouterManaged()) {
        const intfInfo = await FireRouter.getSingleInterface(intf, true).catch((err) => {
          log.error(`Cannot get interface info of ${intf}`, err.message);
          return null;
        });
        if (intfInfo) {
          autonomousPeerInfo = _.get(intfInfo, ["state", "autonomy", "peerInfo"], undefined);
        }
      }
      const dumpResult = await exec(`sudo ${this.wgCmd()} show ${intf} dump | tail +2`).then(result => result.stdout.trim().split('\n')).catch((err) => {
        log.error(`Failed to dump ${this.getProtocol()} peers on ${intf}`, err.message);
        return null;
      });
      if (_.isArray(dumpResult)) {
        await asyncNative.eachLimit(dumpResult, 30, async line => {
          try {
            const [pubKey, psk, endpoint, allowedIPs, latestHandshake, rxBytes, txBytes, keepalive] = line.split('\t');
            if (pubKey) {
              if (hashCopy.hasOwnProperty(pubKey) && _.isObject(hashCopy[pubKey])) {
                const obj = hashCopy[pubKey];
                obj.uid = pubKey;
                obj.lastActiveTimestamp = !isNaN(latestHandshake) && Number(latestHandshake) || null;
                if (!obj.lastActiveTimestamp || obj.lastActiveTimestamp == 0) {
                  const redisKey = this.getRedisKeyVPNWGPeer();
                  const lastActiveTs = await rclient.hgetAsync(`${redisKey}${intf}:${pubKey}`, "lastActiveTimestamp");
                  if (lastActiveTs && Number(lastActiveTs)) {
                    obj.lastActiveTimestamp = Number(lastActiveTs);
                  }
                }
                if (endpoint !== "(none)")
                  obj.endpoint = endpoint;
                obj.rxBytes = !isNaN(rxBytes) && Number(rxBytes) || 0;
                obj.txBytes = !isNaN(rxBytes) && Number(txBytes) || 0;
                if (autonomousPeerInfo && autonomousPeerInfo[pubKey])
                  obj.router = autonomousPeerInfo[pubKey].router;
              } else {
                log.error(`Unknown peer public key: ${pubKey}`);
              }
            }
          } catch (err) {
            log.error(`Failed to parse dump result ${line}`, err.message);
          }
        })
      }
    }));

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
      const protocol = this.getProtocol();
      if (networkConfig && networkConfig.interface && networkConfig.interface[protocol]) {
        intfs = Object.keys(networkConfig.interface[protocol]);
      }
      for (const intf of intfs) {
        const peers = networkConfig.interface[protocol][intf] && networkConfig.interface[protocol][intf].peers || [];
        const peersExtra = networkConfig.interface[protocol][intf] && networkConfig.interface[protocol][intf].extra && networkConfig.interface[protocol][intf].extra.peers || [];
        for (const peer of peers) {
          const pubKey = peer.publicKey;
          const allowedIPs = peer.allowedIPs;
          result[pubKey] = {
            intf: intf,
            publicKey: pubKey,
            allowedIPs: allowedIPs
          };
        }
        await Promise.all(peersExtra.map(async (peerExtra) => {
          const name = peerExtra.name;
          const privateKey = peerExtra.privateKey;
          const pubKey = peerExtra.publicKey || this.privPubKeyMap[privateKey] || await exec(`echo ${privateKey} | ${this.wgCmd()} pubkey`).then(result => result.stdout.trim()).catch((err) => {
            log.error(`Failed to calculate public key from private key ${privateKey}`, err.message);
            return null;
          });
          if (pubKey) {
            this.privPubKeyMap[privateKey] = pubKey;
            if (result[pubKey])
              result[pubKey].name = name;
          }
        }));
      }
    } else if (this === WGPeer) { // only WGPeer need to get peers from extension
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        peer.intf = "wg0";
        const pubKey = peer.publicKey;
        result[pubKey] = peer;
      }
    }

    for (const pubKey of Object.keys(this.wgPeers))
      this.wgPeers[pubKey].active = false;

    for (const pubKey of Object.keys(result)) {
      const o = result[pubKey];
      o.publicKey = pubKey;
      if (this.wgPeers[pubKey])
        await this.wgPeers[pubKey].update(o);
      else
        this.wgPeers[pubKey] = new this(o);
      this.wgPeers[pubKey].active = true;
    }

    await Promise.all(Object.keys(this.wgPeers).map(async pubKey => {
      if (this.wgPeers[pubKey].active === false) {
        delete this.wgPeers[pubKey]
        return;
      }

      const redisMeta = await rclient.hgetallAsync(this.wgPeers[pubKey].getMetaKey())
      Object.assign(this.wgPeers[pubKey].o, WGPeer.parse(redisMeta))
    }));
    return this.wgPeers;
  }

  static async getIPUniqueIdMappings() {
    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      let intfs = [];
      const protocol = this.getProtocol();
      if (networkConfig && networkConfig.interface && networkConfig.interface[protocol]) {
        intfs = Object.keys(networkConfig.interface[protocol]);
      }
      for (const intf of intfs) {
        const peers = networkConfig.interface[protocol][intf] && networkConfig.interface[protocol][intf].peers || [];
        for (const peer of peers) {
          const pubKey = peer.publicKey;
          const allowedIPs = peer.allowedIPs || [];
          for (const ip of allowedIPs) {
            result[ip] = pubKey;
          }
        }
      }
    } else if (this === WGPeer) {
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
    const protocol = this.getProtocol();
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      if (networkConfig && networkConfig.interface && networkConfig.interface[protocol]) {
        intfs = Object.keys(networkConfig.interface[protocol]);
      }
    } else if (this === WGPeer) {
      intfs.push("wg0");
    }

    for (const intf of intfs) {
      const endpointsResults = (await exec(`sudo ${this.wgCmd()} show ${intf} endpoints`).then(result => result.stdout.trim().split('\n')).catch((err) => {
        log.debug(`Failed to show endpoints using ${this.wgCmd()} command`, err.message);
        return [];
      })).map(result => result.split(/\s+/g));
      for (const endpointResult of endpointsResults) {
        const pubKey = endpointResult[0];
        const endpoint = endpointResult[1];
        if (pubKey && endpoint)
          pubKeyEndpointMap[pubKey] = (endpoint !== "(none)" ? endpoint : null);
      }
    }

    const result = {};
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      for (const intf of intfs) {
        const peers = networkConfig.interface[protocol][intf] && networkConfig.interface[protocol][intf].peers || [];
        for (const peer of peers) {
          const pubKey = peer.publicKey;
          const allowedIPs = peer.allowedIPs || [];
          for (const ip of allowedIPs) {
            if (_.has(pubKeyEndpointMap, pubKey))
              result[ip] = pubKeyEndpointMap[pubKey];
          }
        }
      }
    } else if (this === WGPeer) {
      const wireguard = require('../../extension/wireguard/wireguard.js');
      const peers = await wireguard.getPeers();
      for (const peer of peers) {
        const pubKey = peer.publicKey;
        const allowedIPs = peer.allowedIPs || [];
        for (const ip of allowedIPs) {
          if (_.has(pubKeyEndpointMap, pubKey))
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
    const obj = this.toJson();
    return `.vpn.${_.isArray(obj.allowedIPs) && obj.allowedIPs.length > 1 ? "s2s" : "cs"}.wgvpn`;
  }

  getReadableName() {
    return this.o && this.o.name || this.getUniqueId();
  }

  getNicName() {
    return this.o.intf;
  }
}

module.exports = WGPeer;
