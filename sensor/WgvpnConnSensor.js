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
const sem = require('../sensor/SensorEventManager.js').getInstance();
const exec = require('child-process-promise').exec;
const Sensor = require('./Sensor.js').Sensor;
const platform = require('../platform/PlatformLoader.js').getPlatform();
const FireRouter = require('../net2/FireRouter.js');
const _ = require('lodash');
const {Address4, Address6} = require('ip-address');
const Constants = require('../net2/Constants.js');
const Message = require('../net2/Message.js');
const HostManager = require('../net2/HostManager.js');

const peerLastEndpointMap = {};

const CHECK_INTERVAL = 20;

class WgvpnConnSensor extends Sensor {

  run() {
    if (!platform.isWireguardSupported())
      return;

    setInterval(() => {
      this._checkWgPeersActivity().catch((err) => {
        log.error(`Failed to check wireguard peers activity`, err.message);
      })
    }, CHECK_INTERVAL * 1000);
  }

  async _checkWgPeersActivity() {
    let peers = [];
    let enabled = false;
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      if (networkConfig && networkConfig.interface && networkConfig.interface.wireguard) {
        for (const intf of Object.keys(networkConfig.interface.wireguard)) {
          if (networkConfig.interface.wireguard[intf].assetsController)
            continue;
          Array.prototype.push.apply(peers, networkConfig.interface.wireguard[intf].peers);
          enabled = enabled || networkConfig.interface.wireguard[intf].enabled;
        }
      }
    } else {
      const wireguard = require('../extension/wireguard/wireguard.js');
      peers = await wireguard.getPeers();
      const hostManager = new HostManager();
      const policy = await hostManager.getPolicyFast();
      enabled = policy && policy.wireguard && policy.wireguard.state || false;
    }

    if (!enabled)
      return;

    if (_.isArray(peers)) {
      const pubKeys = peers.map(peer => peer.publicKey);
      const results = await exec(`sudo wg show all latest-handshakes`).then(result => result.stdout.trim().split('\n')).catch((err) => {
        log.error(`Failed to show latest-handshakes using wg command`, err.message);
        return [];
      });
      for (const result of results) {
        const [intf, pubKey, latestHandshake] = result.split(/\s+/g);
        if (!pubKeys.includes(pubKey))
          continue;
        if (Number(latestHandshake) > Date.now() / 1000 - CHECK_INTERVAL) {
          let peerIP4s = [];
          let peerIP6s = [];
          for (const peer of peers) {
            if (peer.publicKey === pubKey) {
              const ips = peer.allowedIPs || [];
              peerIP4s = ips.filter(ip => new Address4(ip).isValid());
              peerIP6s = ips.filter(ip => new Address6(ip).isValid());
            }
          }
          let remoteIP = null;
          let remotePort = null;
          const endpointsResults = (await exec(`sudo wg show ${intf} endpoints`).then(result => result.stdout.trim().split('\n')).catch((err) => {
            log.error(`Failed to show endpoints using wg command`, err.message);
            return [];
          })).map(result => result.split(/\s+/g));
          for (const endpointsResult of endpointsResults) {
            if (endpointsResult[0] === pubKey) {
              let endpoint = endpointsResult[1];
              if (endpoint !== "(none)") {
                remoteIP = endpoint.includes(":") ? endpoint.substring(0, endpoint.lastIndexOf(":")) : endpoint;
                remotePort = endpoint.includes(":") ? endpoint.substring(endpoint.lastIndexOf(":") + 1) : 0;
                // remove leading and trailing brackets if it is an IPv6 address
                if (remoteIP.startsWith("["))
                  remoteIP = remoteIP.substring(1);
                if (remoteIP.endsWith("]"))
                  remoteIP = remoteIP.substring(0, remoteIP.length - 1);
              }
            }
          }
          if (peerLastEndpointMap[pubKey] === `${remoteIP}:${remotePort}`) {
            return;
          }
          peerLastEndpointMap[pubKey] = `${remoteIP}:${remotePort}`;
          log.info(`Wireguard VPN client connection accepted, remote ${remoteIP}:${remotePort}, peer ipv4: ${peerIP4s.length > 0 ? peerIP4s[0] : null}, peer ipv6: ${peerIP6s.length > 0 ? peerIP6s[0] : null}, public key: ${pubKey}`);
          const event = {
            type: Message.MSG_WG_CONN_ACCEPTED,
            message: "A new wireguard VPN connection was accepted",
            client: {
              remoteIP: remoteIP,
              remotePort: remotePort,
              peerIP4: peerIP4s.length > 0 ? peerIP4s[0] : null,
              peerIP6: peerIP6s.length > 0 ? peerIP6s[0] : null,
              profile: pubKey,
              vpnType: Constants.VPN_TYPE_WG
            }
          };
          sem.sendEventToAll(event);
        }
      }
    }
  }
}

module.exports = WgvpnConnSensor;
