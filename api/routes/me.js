/*    Copyright 2016-2026 Firewalla Inc.
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

const express = require('express');
const router = express.Router();

const log = require('../../net2/logger.js')(__filename);
const HostManager = require('../../net2/HostManager.js');
const sysManager = require('../../net2/SysManager.js');
const VPNProfile = require('../../net2/identity/VPNProfile.js');
const WGPeer = require('../../net2/identity/WGPeer.js'); // AWGPeer extends WGPeer
const IdentityManager = require('../../net2/IdentityManager.js');
const fwapc = require('../../net2/fwapc.js');
const firewalla = require('../../net2/Firewalla.js');
const platform = require('../../platform/PlatformLoader').getPlatform();
const _ = require('lodash');
const { findPathByMac, buildHops } = require('./meTopology.js');
const { execFile } = require('child-process-promise');
const net = require('net');
const LRU = require('lru-cache');


const hostManager = new HostManager();

// cache of topology info (device + hops + topologyError) keyed by device IP, latency excluded
const topologyCache = new LRU({ max: 20, maxAge: 60 * 1000 }); // 1 minute

function getClientIP(req) {
  let ip = req.connection && req.connection.remoteAddress;
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

// "1.2.3.4:5678" -> "1.2.3.4", "[::1]:5678" -> "::1" (endpoint format used by both
// `wg/awg show <intf> endpoints` and the OpenVPN management interface's "Real Address").
// OpenVPN's "Real Address" may also be a bare IP with no port (e.g. multihome mode),
// including a bare IPv6 address, so a plain IP literal must be accepted as-is.
function endpointToIP(endpoint) {
  if (!endpoint) return null;
  if (net.isIP(endpoint)) return endpoint;
  if (endpoint.startsWith('[') && endpoint.includes(']:'))
    return endpoint.substring(1, endpoint.indexOf(']:'));
  // "1.2.3.4:5678" (IPv4 with port); a bare IPv6 address would have already
  // matched net.isIP above, so any remaining colon here is a port separator
  return endpoint.split(':')[0];
}

// ping the given IP from the box running /v1/me and return the average RTT in ms (null on failure)
async function pingLatency(ip) {
  // only ping validated IP literals; never interpolate untrusted input into a shell
  if (!ip || !net.isIP(ip)) return null;
  try {
    const result = await execFile('ping', ['-c', '5', '-W', '1', '-w', '1', '-i', '0.1', ip], { timeout: 2000 });
    const stdout = result && result.stdout || '';
    // rtt min/avg/max/mdev = 0.123/0.456/0.789/0.111 ms
    const m = stdout.match(/=\s*[\d.]+\/([\d.]+)\//);
    if (m) return Math.round(parseFloat(m[1]) * 100) / 100;
    return null;
  } catch (err) {
    // the target may block ICMP (e.g. a device that drops pings); treat as unknown latency, not an error
    log.debug(`Failed to ping ${ip}`, err.message);
    return null;
  }
}

// build the topology (device + hops + topologyError) for the given target IP; this is the expensive part cached by IP
async function buildTopology(target) {
  const monitorable = await hostManager.getIdentityOrHost(target);
  if (!monitorable) {
    return { notFound: true };
  }

  const mac = monitorable.getUniqueId();
  const device = {
    name: monitorable.getReadableName ? monitorable.getReadableName() : mac,
    mac,
    ip: target,
  };

  let hops = null;
  let topologyError = null;
  try {
    const treeInfo = await fwapc.getWiredStationTree();
    const tree = treeInfo && treeInfo.tree;
    if (!Array.isArray(tree)) {
      topologyError = 'Invalid network topology data';
    }

    let path = null;
    let vpnRealMac = null; // mac of the real device a VPN client resolved to via realDevice, if any
    let connIp = null; // IP the VPN client actually connected from, if any
    if (monitorable instanceof VPNProfile || monitorable instanceof WGPeer) {
      device.type = 'vpn';
      // VPN clients (OpenVPN/WireGuard/AmneziaWG) have no real MAC in the physical
      // topology tree. IdentityManager already tracks the address each VPN client actually
      // connected from (wg/awg "endpoints", OpenVPN management interface "Real Address").
      connIp = endpointToIP(IdentityManager.getEndpointByIP(target));
      if (connIp && sysManager.isLocalIP(connIp)) {
        // client connected in from inside the LAN (e.g. site-to-site peer, or testing
        // locally); locate its real device in the physical tree by that IP instead
        const realDevice = await hostManager.getHostAsync(connIp);
        if (realDevice) {
          vpnRealMac = realDevice.getUniqueId();
          path = findPathByMac(tree, vpnRealMac);
        }
      }
      if (!path && Array.isArray(tree) && tree.length) {
        // remote VPN client (or its real LAN position is unknown): assume it reaches
        // the box directly over WAN, i.e. box -> vpn client with no AP/switch hops
        path = [tree[0], { type: 'vpn', mac, name: device.name, ip: connIp, connectionType: 'vpn' }];
      }
    } else {
      path = findPathByMac(tree, mac);
    }

    if (!path) {
      topologyError = 'Device not found in network topology';
    } else {
      // print path for debugging
      log.debug(`Found path for device ${mac}:`, path.map(node => ({
        type: node.type,
        name: node.name,
        mac: node.mac,
        connectionType: node.connectionType,
      })));
      hops = buildHops(path);
    }

    const apStatus = await fwapc.getAssetsStatus().catch((err) => {
      log.error(`Failed to get assets status from fwapc`, err.message);
      return null;
    });
    if (!apStatus || !_.isObject(apStatus) ) {
      topologyError = 'Failed to fetch network topology';
    }
    const switchStatus = await fwapc.getSwitchStatus().catch((err) => {
      log.error(`Failed to get switch status from fwapc`, err.message);
      return null;
    });
    if (!switchStatus || !_.isObject(switchStatus) ) {
      topologyError = 'Failed to fetch network topology';
    }
    for (const hop of (Array.isArray(hops) ? hops : [])) {
      const hmac = hop.mac;
      if (!hmac) continue;
      switch (hop.type) {
        case 'box':
          if (sysManager.isMyMac(hmac)) {
            hop.name = await firewalla.getBoxName();
            hop.model = platform.getName();
            // hop.interfaceSpec = getModelInterfaceSpec('box', hop.model);
          }
          break;
        case 'ap':
          if (apStatus && apStatus[hmac]) {
            const assetInfo = apStatus[hmac];
            if (assetInfo.model) {
              hop.model = assetInfo.model;
            }
            if (hmac == mac) {
              device.type = hop.type;
              device.model = hop.model;
            }
            // if (assetInfo.name) { // AP name
            //   hop.name = assetInfo.name;
          }
          break;
        case 'switch':
          if (switchStatus && switchStatus[hmac]) {
            const assetInfo = switchStatus[hmac];
            if (assetInfo.model) {
              hop.model = assetInfo.model;
            }
            if (hmac == mac) {
              device.type = hop.type;
              device.model = hop.model;
            }
            // if (assetInfo.sysConfig && assetInfo.sysConfig.name) { // switch name
            //   hop.name = assetInfo.sysConfig.name;
            // }
          }
          break;
        case 'device':
          if (hop.connectionType === 'vpn') {
            hop.type = 'vpn';
            break; // synthetic hop, hmac is not a real MAC
          }
          if (vpnRealMac && hmac === vpnRealMac) {
            hop.type = 'vpn';
          } else if (monitorable.detect && monitorable.detect.type) {
            hop.type = monitorable.detect.type;
            hop.name = device.name;
            device.type = hop.type;
          }
          const staInfo = await fwapc.getSTAStatus(hmac).catch((err) => {
            log.error(`Failed to get wireless station info for ${hmac}`, err.message);
            return null;
          });
          if (staInfo && staInfo.channel != null && hop.isWireless) {
            hop.channel = staInfo.channel;
          }
          break;
        default:
          break;
      }
    }
  } catch (err) {
    log.error('Failed to fetch wired station tree', err.message);
    topologyError = 'Failed to fetch network topology';
  }

  log.debug(`Topology for ${target} (${mac}): device=${JSON.stringify(device)}, hops=${JSON.stringify(hops)}, topologyError=${topologyError}`);

  return { device, hops, topologyError };
}

router.get('/', async (req, res) => {
  let target = getClientIP(req);

  if (req.query && req.query.ip) {
    if (firewalla.isDevelopmentVersion()) {
      target = req.query.ip;
    } else {
      if (!target || !sysManager.isLocalIP(target)) {
        res.status(403).json({ error: 'Access allowed only from local network' });
        return;
      }
    }
  } else if (!target || !sysManager.isLocalIP(target)) {
    res.status(403).json({ error: 'Access allowed only from local network' });
    return;
  }

  try {
    // topology is cached by IP (1 minute); latency is always probed fresh below
    let topology = topologyCache.get(target);
    if (!topology) {
      topology = await buildTopology(target);
      if (!topology.notFound) {
        topologyCache.set(target, topology);
      }
    }

    if (topology.notFound) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const { device, topologyError } = topology;
    // clone hops so per-request latency values never mutate the cached copy
    const hops = topology.hops ? _.cloneDeep(topology.hops) : topology.hops;

    // probe latency from the root hop (the box running /v1/me) to each hop, on every request
    if (Array.isArray(hops)) {
      await Promise.all(hops.map(async (hop, index) => {
        // root hop is the box itself, latency to itself is 0
        if (index === 0 && hop.type === 'box' && sysManager.isMyMac(hop.mac)) {
          hop.latency = 0;
          return;
        }
        hop.latency = await pingLatency(hop.ip);
      }));
    }

    res.json({
      device,
      hops,
      topologyError,
    });
  } catch (err) {
    log.error('Failed to build /v1/me response', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

module.exports = router;
