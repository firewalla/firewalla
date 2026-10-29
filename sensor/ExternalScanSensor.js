/*    Copyright 2020-2021 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient();

const { rrWithErrHandling } = require('../util/requestWrapper.js')
const tokenManager = require('../util/FWTokenManager.js');
const _ = require('lodash');
const EncipherTool = require('../net2/EncipherTool.js');
const extensionManager = require('./ExtensionManager.js');
const sysManager = require('../net2/SysManager.js');
const Constants = require('../net2/Constants.js');
const fc = require('../net2/config.js');
const net = require('net');
const FireRouter = require('../net2/FireRouter.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const PortForward = require('../extension/portforward/portforward.js');
const encipherTool = new EncipherTool();
const portForward = new PortForward();
const delay = require('../util/util.js').delay;

const STATE_SCANNING = "scanning";
const STATE_IDLE = "idle";

const ERR_COOLDOWN = "ERR_CD";
const ERR_NO_PUB_IP = "ERR_NO_PUB_IP";

const OWNER_VPN_SERVER = "vpn_server";
const OWNER_WIREGUARD = "wireguard";
const OWNER_AMNEZIAWG = "amneziawg";
const OWNER_PORT_FORWARD = "port_forward";
const OWNER_UPNP = "upnp";
const OWNER_DMZ_HOST = "dmz_host";

const PORT_FORWARD_CONFIG_KEY = "extension.portforward.config";
const UPNP_MAPPING_KEY = "sys:scan:nat";
const SYSTEM_POLICY_KEY = "policy:system";

const BOTH_PROTOCOLS = ["tcp", "udp"];
const DMZ_EXCLUDED_PORTS = {
  tcp: [22, 53, 8833, 8834, 8835, 8837, 8853],
  udp: [53, 8853]
};

class ExternalScanSensor extends Sensor {
  constructor(config) {
    super(config);
  }

  async apiRun() {
    this.wanScanResults = {};
    this.wanScanStartTs = {};
    const scanCD = this.config.scanCooldown || 300;
    this.scanServerURL = this.config.scanServerURL || "https://scan.encipher.io:18888/scan";

    extensionManager.onCmd("startExternalScan", async (msg, data) => {
      const {target} = data; // target == "0.0.0.0" -> scan all wans; target == wan.uuid -> only scan this wan
      const wansToScan = [];
      const wans = sysManager.getWanInterfaces();
      const publicIps = sysManager.publicIps;
      const now = Date.now() / 1000;
      let errors = [];
      for (const wan of wans) {
        if (target === "0.0.0.0" || target === wan.uuid) {
          // The frequency is too high
          if (this.wanScanStartTs[wan.uuid] && now - this.wanScanStartTs[wan.uuid] < scanCD) {
            errors.push({err: ERR_COOLDOWN, wanUUID: wan.uuid, msg: `External scan on WAN ${wan.name} is on a cooldown`});
          } else {
            if (!_.has(publicIps, wan.name) && _.isEmpty(wan.ip6_addresses)) {
              errors.push({err: ERR_NO_PUB_IP, wanUUID: wan.uuid, msg: `WAN ${wan.name} does not have public IPv4/IPv6 addresses`});
            } else
              wansToScan.push(wan);
          }
        }
      }
      if (_.isEmpty(wansToScan)) {
        return {results: await this.getScanResults(), errors};
      }
      let finished = false;
      Promise.all(wansToScan.map(async (wan) => {
        if (!_.has(this.wanScanResults, wan.uuid))
          this.wanScanResults[wan.uuid] = {};
        const scanResult = this.wanScanResults[wan.uuid];
        if (scanResult.state === STATE_SCANNING)
          return;
        scanResult.state = STATE_SCANNING;
        scanResult.ts = now;
        this.wanScanStartTs[wan.uuid] = now;
        await this.scanWAN(publicIps[wan.name], wan.ip6_addresses).then(async (result) => {
          await this.annotatePortOwners(wan, result).catch((err) => {
            log.error(`Failed to identify port owners on WAN ${wan.uuid}`, err.message);
          });
          scanResult.ets = Date.now() / 1000;
          scanResult.result = result;
          scanResult.state = STATE_IDLE;
          await this.saveScanResult(wan.uuid, scanResult);
        }).catch((err) => {
          log.error(`Failed to run external scan on WAN ${wan.uuid}`, err.message);
          scanResult.state = STATE_IDLE;
        });
      })).catch((err) => {
        log.error(`Failed to scan wans`, err.message);
      }).finally(() => {
        finished = true;
      });
      for (let i = 0; i != 20; i++) {
        await delay(3000);
        if (finished)
          break;
      }
      return {results: await this.getScanResults(), errors};
    });

    extensionManager.onGet("externalScanResults", async (msg, data) => {
      return {results: await this.getScanResults()};
    });
  }

  async scanWAN(ipv4, ipv6s) {
    const ips = [];
    if (ipv4)
      ips.push(ipv4);
    if (_.isArray(ipv6s)) {
      const publicIpv6s = sysManager.filterPublicIp6(ipv6s);
      if (!_.isEmpty(publicIpv6s))
        ips.push(publicIpv6s[0]); // do not scan too many ip addresses, otherwise HTTP 429 will be triggered from cloud
    }
    const result = [];
    const eid = await encipherTool.getEID();
    const token = await tokenManager.getToken()

    await Promise.all(ips.map(async ip => {
      const uri = `${this.scanServerURL}/${eid}/${ip}/${ip}`;
      log.info(`Send to cloud for external scan`, uri);
      const options = { uri, method: "GET", auth: { bearer: token }, json: true, maxAttempts: 2, retryDelay: 11 * 1000 };
      const response = await rrWithErrHandling(options);
      if (response && response.body) {
        if (_.isArray(response.body.scan))
          response.body.scan = response.body.scan.filter(entry => entry.portid !== "0")
        result.push(response.body);
      }
    }));
    return result;
  }

  async annotatePortOwners(wan, results) {
    const managedPorts = await this.getManagedPorts(wan);
    for (const result of results) {
      const candidates = net.isIPv6(result.ip) ? managedPorts.filter(o => !o.ipv4Only) : managedPorts;
      for (const entry of result.scan || []) {
        const port = Number(entry.portid);
        const protocol = _.toLower(entry.protocol);
        const matched = candidates.find(o => o.protocols.includes(protocol) && port >= o.start && port <= o.end);
        if (matched)
          entry.owner = { type: matched.type };
      }
    }
  }

  getProtocols(protocol) {
    return protocol ? [_.toLower(protocol)] : BOTH_PROTOCOLS;
  }

  // ports reachable from the internet because a Firewalla feature opened them, and which feature did
  async getManagedPorts(wan) {
    const managedPorts = [];
    const vpn = JSON.parse(await rclient.hgetAsync(SYSTEM_POLICY_KEY, "vpn") || "null");
    const vpnEnabled = Boolean(vpn && vpn.state === true && vpn.localPort);

    // 1. upnp
    const upnpMappings = JSON.parse(await rclient.hgetAsync(UPNP_MAPPING_KEY, "upnp") || "[]");
    const now = Date.now() / 1000;
    for (const mapping of upnpMappings) {
      // filter
      if (mapping.enabled === false || !mapping.public || !mapping.private || (mapping.expire && mapping.expire < now))
        continue;
      const port = Number(mapping.public.port);
      const isVpnMapping = vpnEnabled &&
        sysManager.isMyIP(mapping.private.host) &&
        _.toLower(mapping.protocol) === _.toLower(vpn.protocol) &&
        Number(mapping.private.port) === Number(vpn.localPort) &&
        port === Number(vpn.externalPort);
      const type = isVpnMapping ? OWNER_VPN_SERVER : OWNER_UPNP;
      managedPorts.push({ protocols: this.getProtocols(mapping.protocol), start: port, end: port, ipv4Only: true, type });
    }

    // 2. port forwarding
    const portForwardConfig = JSON.parse(await rclient.getAsync(PORT_FORWARD_CONFIG_KEY) || "null");
    const wanIPv4s = _.compact([...(wan.ip4_addresses || []), _.get(sysManager.publicIps, wan.name)]);
    const maps = [];
    // filter maps that actually take effect on this wan
    for (const map of _.get(portForwardConfig, "maps", [])) {
      // exclude "bind to other wan"
      if (map.wanUUID && !map.applyToAll && map.wanUUID !== wan.uuid)
        continue;
      // exclude "bind to an ext ip that is not on this wan"
      if (map.extIP && !wanIPv4s.includes(map.extIP))
        continue;
      // exclude "disabled, out of schedule, or not applied to iptables for other reasons"
      if (await portForward._shouldBeApplied(map))
        maps.push(map);
    }
    for (const map of maps) {
      // deal with dmz in step 6
      if (map._type === OWNER_DMZ_HOST || !map.dport)
        continue;
      const [start, end = start] = String(map.dport).split(/[-:]/).map(Number);
      managedPorts.push({ protocols: this.getProtocols(map.protocol), start, end, ipv4Only: true, type: OWNER_PORT_FORWARD });
    }

    // 3. vpn server
    if (vpnEnabled) {
      const protocols = this.getProtocols(vpn.protocol);
      const localPort = Number(vpn.localPort);
      managedPorts.push({ protocols, start: localPort, end: localPort, ipv4Only: false, type: OWNER_VPN_SERVER });
      const externalPort = Number(vpn.externalPort);
      if (vpn.portmapped === true && externalPort && externalPort !== localPort)
        managedPorts.push({ protocols, start: externalPort, end: externalPort, ipv4Only: true, type: OWNER_VPN_SERVER });
    }

    // 4. wireguard
    let wireguardPorts = [];
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      wireguardPorts = Object.values(_.get(networkConfig, ["interface", "wireguard"], {}))
        .filter(intf => intf.enabled && intf.listenPort && !intf.assetsController && !intf.fwapc)
        .map(intf => Number(intf.listenPort));
    } else {
      const wireguard = JSON.parse(await rclient.hgetAsync(SYSTEM_POLICY_KEY, OWNER_WIREGUARD) || "null");
      if (fc.isFeatureOn(OWNER_WIREGUARD) && wireguard && wireguard.state === true && wireguard.listenPort)
        wireguardPorts = [Number(wireguard.listenPort)];
    }
    for (const port of wireguardPorts)
      managedPorts.push({ protocols: ["udp"], start: port, end: port, ipv4Only: false, type: OWNER_WIREGUARD });

    // 5. amneziawg
    if (platform.isFireRouterManaged()) {
      const networkConfig = await FireRouter.getConfig();
      const amneziawgPorts = Object.values(_.get(networkConfig, ["interface", "amneziawg"], {}))
        .filter(intf => intf.enabled && intf.listenPort)
        .map(intf => Number(intf.listenPort));
      for (const port of amneziawgPorts)
        managedPorts.push({ protocols: ["udp"], start: port, end: port, ipv4Only: false, type: OWNER_AMNEZIAWG });
    }

    // 6. dmz host
    if (maps.some(m => m._type === OWNER_DMZ_HOST)) {
      for (const protocol of BOTH_PROTOCOLS) {
        let start = 1;
        for (const port of _.sortBy(DMZ_EXCLUDED_PORTS[protocol])) {
          if (port > start)
            managedPorts.push({ protocols: [protocol], start, end: port - 1, ipv4Only: true, type: OWNER_DMZ_HOST });
          start = port + 1;
        }
        if (start <= 65535)
          managedPorts.push({ protocols: [protocol], start, end: 65535, ipv4Only: true, type: OWNER_DMZ_HOST });
      }
    }

    return managedPorts;
  }

  async getScanResults() {
    const results = {};
    const redisResults = await rclient.hgetallAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT) || {};
    const wans = sysManager.getWanInterfaces();
    for (const wan of wans) {
      if (_.has(redisResults, wan.uuid))
        results[wan.uuid] = JSON.parse(redisResults[wan.uuid]);
      if (_.has(this.wanScanResults, wan.uuid)) {
        results[wan.uuid] = Object.assign(results[wan.uuid] || {}, this.wanScanResults[wan.uuid]);
      }
    }
    for (const uuid of Object.keys(redisResults)) {
      if (!_.has(results, uuid))
        await rclient.hdelAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT, uuid);
    }
    return results;
  }

  async saveScanResult(wanUUID, result) {
    await rclient.hsetAsync(Constants.REDIS_KEY_EXT_SCAN_RESULT, wanUUID, JSON.stringify(result));
  }
}

module.exports = ExternalScanSensor;