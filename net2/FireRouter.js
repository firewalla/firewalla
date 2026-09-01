/*    Copyright 2019-2025 Firewalla Inc.
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

// this module should be responsible for connecting firewalla and fireroute together
// more specifically:
//    inquery and update regarding to
//      physical/bridge/virtual interfaces, DNS, NAT, DHCP
//    serving as FireRouter on RED & BLUE
//      create secondaryInterface
//      start bro, dnsmasq if necessary
//      generating compatible config


//  An Interface class?
//  {
//    name
//    gateway: {ipv4, ipv4}
//    subnet
//    dnsmasq as a pre-interface instance?
//  }

const log = require("./logger.js")(__filename);

const layer2 = require('../util/Layer2.js');
const nmap = require('./Nmap.js');
const f = require('../net2/Firewalla.js');
const SysTool = require('../net2/SysTool.js')
const sysTool = new SysTool()
const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const Config = require('./config.js')
const rclient = require('../util/redis_manager.js').getRedisClient()
const { delay } = require('../util/util.js')
const pclient = require('../util/redis_manager.js').getPublishClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('./Message.js');
const Mode = require('./Mode.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const QoS = require('../control/QoS.js');
const { rrWithErrHandling } = require('../util/requestWrapper.js')
const fsp = require('fs').promises;

const util = require('util')
const rp = util.promisify(require('request'))
const { Address4, Address6 } = require('ip-address')
const _ = require('lodash');
const exec = require('child-process-promise').exec;
const era = require('../event/EventRequestApi.js');
const AsyncLock = require('../vendor_lib/async-lock');
const Constants = require("./Constants.js");
const lock = new AsyncLock();
const LOCK_INIT = "LOCK_INIT";

const ERR_NCID_NOT_MATCH = "ERR_NCID_NOT_MATCH";

// not exposing these methods/properties
async function localGet(endpoint, retry = 5) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  const response = await rrWithErrHandling({
    uri: routerInterface + endpoint,
    method: "GET",
    maxAttempts: retry,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: true,
  })

  return response.body
}

async function localSet(endpoint, body, retry = 5) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  const response = await rrWithErrHandling({
    uri: routerInterface + endpoint,
    method: "POST",
    maxAttempts: retry,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: body,
  })

  return response.body
}

async function getConfig() {
  return localGet("/config/active")
}

async function setConfig(config) {
  return localSet("/config/set", config)
}


async function getWANInterfaces() {
  return localGet("/config/wans")
}

async function getLANInterfaces() {
  return localGet("/config/lans")
}

async function getInterfaces() {
  return localGet("/config/interfaces")
}

async function getInterface(intf) {
  return localGet(`/config/interfaces/${intf}`, 2)
}

async function getPowerMode() {
  return localGet("/config/power_mode");
}

async function setPowerMode(powerMode) {
  return localSet("/config/power_mode", { powerMode });
}

function updateMaps() {
  if (!_.isObject(intfNameMap))
    return false;
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    // this usually happens after consecutive network config update, internal data structure of interface in firerouter is incomplete
    if (!intf.config || !intf.config.meta) {
      log.error(`Interface ${intfName} does not have config or config.meta`)
      return false;
    }
    intf.config.meta.intfName = intfName
    intfUuidMap[intf.config.meta.uuid] = intf
  }
  return true;
}


function safeCheckMonitoringInterfaces(monitoringInterfaces) {
  // filter pppoe interfaces
  return monitoringInterfaces.filter(i => !i.startsWith("ppp"));
}

function getRaRouterLifetime(intf) {
  if (!intf || !intf.config || !intf.config.meta || intf.config.meta.type !== "wan")
    return null;

  const value = intf.state && intf.state.ra_router_lifetime;
  if (Number.isInteger(value) && value >= 0 && value <= 65535)
    return value;

  return null;
}

async function generateNetworkInfo() {
  const networkInfos = [];
  const mode = await rclient.getAsync('mode');
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    const ip4 = intf.state.ip4 ? new Address4(intf.state.ip4) : null;
    const searchDomains = (routerConfig && routerConfig.dhcp && routerConfig.dhcp[intfName] && routerConfig.dhcp[intfName].searchDomain) || [];
    const localDomains = intf.config && intf.config.extra && intf.config.extra.localDomains || [];
    let ip4s = [];
    let ip4Masks = [];
    let ip4Subnets = [];
    if (intf.state.ip4s && _.isArray(intf.state.ip4s)) {
      for (const i of intf.state.ip4s) {
        const ip4Addr = new Address4(i);
        if (!ip4Addr.isValid())
          continue;
        ip4s.push(ip4Addr.correctForm());
        ip4Masks.push(new Address4(`255.255.255.255/${ip4Addr.subnetMask}`).startAddress().correctForm());
        ip4Subnets.push(i);
      }
    }
    if (ip4s.length === 0 && ip4) {
      ip4s.push(ip4.addressMinusSuffix);
      ip4Masks.push(new Address4(`255.255.255.255/${ip4.subnetMask}`).startAddress().correctForm());
      ip4Subnets.push(intf.state.ip4);
    }
    let ip6s = [];
    let ip6Masks = [];
    let ip6Subnets = [];
    if (intf.state.ip6 && _.isArray(intf.state.ip6)) {
      for (let i of intf.state.ip6) {
        const ip6Addr = new Address6(i);
        if (!ip6Addr.isValid())
          continue;
        ip6s.push(ip6Addr.correctForm());
        ip6Masks.push(new Address6(`ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/${ip6Addr.subnetMask}`).startAddress().correctForm());
        ip6Subnets.push(i);
      }
    }
    let rt4Subnets = [];
    let rt6Subnets = [];
    if (intf.state.routableSubnets && _.isArray(intf.state.routableSubnets)) {
      for (const cidr of intf.state.routableSubnets) {
        let addr = new Address4(cidr);
        if (addr.isValid()) {
          rt4Subnets.push(`${addr.startAddress().correctForm()}/${addr.subnetMask}`);
        } else {
          addr = new Address6(cidr);
          if (addr.isValid()) {
            rt6Subnets.push(`${addr.startAddress().correctForm()}/${addr.subnetMask}`);
          }
        }
      }
    }
    let gateway = null;
    let gateway6 = null;
    let raRouterLifetime = null;
    let gatewayMac
    let dns = null;
    let dns6 = null;
    let resolver = null;
    let resolverFromWan = false;
    const resolverConfig = (routerConfig && routerConfig.dns && routerConfig.dns[intfName]) || null;
    let type = intf.config.meta.type;
    if (resolverConfig) {
      if (resolverConfig.useNameserversFromWAN) {
        const defaultRoutingConfig = routerConfig && routerConfig.routing && ((routerConfig.routing[intfName] && routerConfig.routing[intfName].default) || (routerConfig.routing.global && routerConfig.routing.global.default));
        resolverFromWan = true;
        if (defaultRoutingConfig) {
          let viaIntf = defaultRoutingConfig.viaIntf;
          if (defaultRoutingConfig === routerConfig.routing.global.default) // use default dns from global default WAN interface if no interface-specific default WAN is configured
            viaIntf = defaultWanIntfName;
          if (intfNameMap[viaIntf]) {
            resolver = intfNameMap[viaIntf].config.nameservers || intfNameMap[viaIntf].state.dns;
            const resolv6 = intfNameMap[viaIntf].config.dns6Servers || intfNameMap[viaIntf].state.dns6;
            if (resolv6)
              resolver = resolver == null ? resolv6 : resolver.concat(resolv6);
          }
        }
      } else {
        if (resolverConfig.nameservers)
          resolver = resolverConfig.nameservers;
        if (resolverConfig.dns6Servers)
          resolver = resolver == null ? resolverConfig.dns6Servers : resolver.concat(resolverConfig.dns6Servers)
      }
    }
    dns = intf.config.nameservers || intf.state.dns;
    dns6 = intf.config.dns6Servers || intf.state.dns6;
    switch (intf.config.meta.type) {
      case "wan": {
        gateway = intf.config.gateway || intf.state.gateway;
        gateway6 = intf.config.gateway6 || intf.state.gateway6;
        raRouterLifetime = getRaRouterLifetime(intf);
        if (!intfName.startsWith("pppoe")) {
          gatewayMac = gateway && await layer2.getMACAsync(gateway) || gateway6 && await nmap.neighborSolicit(gateway6);
        }
        break;
      }
      case "lan": {
        // no gateway and dns for lan interface, gateway and dns in dhcp does not mean the same thing
        gateway = null;
        gateway6 = null;
        break
      }
    }
    // always consider wan as lan in DHCP mode, which will affect port forward and VPN client
    if (mode === Mode.MODE_DHCP && type === "wan")
      type = "lan";

    const redisIntf = {
      name:         intfName,
      desc:         intf.config.meta.name,
      uuid:         intf.config.meta.uuid,
      mac_address:  intf.state.mac,
      ip_address:   ip4 ? ip4.addressMinusSuffix : null,
      subnet:       intf.state.ip4,
      netmask:      ip4 ? Address4.fromInteger(((0xffffffff << (32-ip4.subnetMask)) & 0xffffffff) >>> 0).address : null,
      gateway_ip:   gateway,
      gateway:      gateway,
      ip4_addresses: ip4s.length > 0 ? ip4s : null,
      ip4_subnets:  ip4Subnets.length > 0 ? ip4Subnets : null,
      ip4_masks:    ip4Masks.length > 0 ? ip4Masks : null,
      ip6_addresses: ip6s.length > 0 ? ip6s : null,
      ip6_subnets:  ip6Subnets.length > 0 ? ip6Subnets : null,
      ip6_masks:    ip6Masks.length > 0 ? ip6Masks : null,
      gateway6:     gateway6,
      ra_router_lifetime: raRouterLifetime,
      dns:          dns,
      dns6:         dns6,
      resolver:     resolver,
      resolverFromWan: resolverFromWan,
      // carrier:      intf.state && intf.state.carrier == 1, // need to find a better place to put this
      conn_type:    'Wired', // probably no need to keep this,
      type:         type,
      rtid:         intf.state.rtid || 0,
      searchDomains: searchDomains,
      localDomains: localDomains,
      rt4_subnets: rt4Subnets.length > 0 ? rt4Subnets : null,
      rt6_subnets: rt6Subnets.length > 0 ? rt6Subnets : null
    }

    if (gatewayMac) redisIntf.gatewayMac = gatewayMac

    if (intf.state && intf.state.wanConnState) {
      redisIntf.ready = intf.state.wanConnState.ready || false;
      redisIntf.active = intf.state.wanConnState.active || false;
      redisIntf.pendingTest = intf.state.wanConnState.pendingTest || false;
    }

    if (intf.state && intf.state.hasOwnProperty("essid")) {
      redisIntf.essid = intf.state.essid;
    }

    if (intf.state && intf.state.hasOwnProperty("vendor")) {
      redisIntf.vendor = intf.state.vendor;
    }

    if (intf.state && intf.state.hasOwnProperty("origDns")) {
      redisIntf.origDns = intf.state.origDns;
    }

    if (intf.state && intf.state.hasOwnProperty("origDns6")) {
      redisIntf.origDns6 = intf.state.origDns6;
    }

    if (intf.state && intf.state.hasOwnProperty("pds")) {
      redisIntf.pds = intf.state.pds;
    }

    if (intf.config.vid) {
      redisIntf.vid = intf.config.vid
    } else if (intfName.startsWith("br") && Array.isArray(intf.config.intf) && !_.isEmpty(intf.config.intf)) {
      const vid = intfNameMap[intf.config.intf[0]].config.vid
      if (vid) redisIntf.vid = vid
    }

    if (f.isMain()) {
      await rclient.hsetAsync('sys:network:info', intfName, JSON.stringify(redisIntf))
      await rclient.hsetAsync('sys:network:uuid', redisIntf.uuid, JSON.stringify(redisIntf))
    }
    networkInfos.push(redisIntf);
  }
  if (f.isMain()) {
    await pclient.publishAsync(Message.MSG_SYS_NETWORK_INFO_UPDATED, "");
  }
  return networkInfos;
}

// internal properties
let routerInterface = null
let routerConfig = null
let monitoringIntfNames = [];
let rspanIntfNames = [];
let rspanVids = new Set();
let logicIntfNames = [];
let wanIntfNames = null
let defaultWanIntfName = null
let primaryWanIntfName = null
let wanType = null
let intfNameMap = {}
let intfUuidMap = {}

class FireRouter {
  constructor() {
    log.info(`platform is: ${platform.constructor.name}`);

    const fwConfig = Config.getConfig();

    if (!fwConfig.firerouter || !fwConfig.firerouter.interface) return null

    const intf = fwConfig.firerouter.interface;
    routerInterface = `http://${intf.host}:${intf.port}/${intf.version}`;


    this.ready = false
    this.sysNetworkInfo = [];

    this.retryUntilInitComplete()

    sclient.on("message", async (channel, message) => {
      if (!this.ready)
        return;
      let reloadNeeded = false;
      switch (channel) {
        case Message.MSG_FR_WAN_STATE_CHANGED: {
          reloadNeeded = true;
          break;
        }
        case Message.MSG_FR_WAN_CONN_CHANGED: {
          if (!f.isMain())
            return;
          const changeDesc = (message && JSON.parse(message)) || null;
          if (changeDesc) {
            await this.notifyWanConnChange(changeDesc);
            reloadNeeded = true;
          }
          break;
        }
        case Message.MSG_FR_RELOAD:
        case Message.MSG_FR_CONFIG_CHANGED: {
          reloadNeeded = true;
          break;
        }
        case Message.MSG_FR_FORCE_RELOAD: {
          await this.reload();
          break;
        }
        case Message.MSG_FR_STATE_CHANGED: {
          reloadNeeded = true;
          break;
        }
        case Message.MSG_FR_WAN_IP_CHANGED: {
          reloadNeeded = true;
          break;
        }
        case Message.MSG_FR_WAN_STATE_CHANGED: {
          reloadNeeded = true;
          break;
        }
      }
      if (reloadNeeded)
        await this.reload();
    });
  }

  async init() {
    await this.reload();
    this.ready = true;
  }

  async reload() {
    await this._load();
    this.sysNetworkInfo = await generateNetworkInfo();
    this.wanIntfNames = wanIntfNames;
    this.defaultWanIntfName = defaultWanIntfName;
    this.primaryWanIntfName = primaryWanIntfName;
    this.wanType = wanType;
  }

  async _load() {
    routerConfig = await getConfig();
    const intfs = await getInterfaces();

    intfNameMap = {};
    intfUuidMap = {};

    for (const intf of intfs) {
      if (!intf || !intf.config || !intf.config.meta)
        continue;

      const intfName = intf.config.meta.intfName;
      if (!intfName)
        continue;

      intfNameMap[intfName] = intf;
    }

    updateMaps();

    const wans = await getWANInterfaces();
    wanIntfNames = wans.map(i => i.config.meta.intfName);
    defaultWanIntfName = routerConfig && routerConfig.routing && routerConfig.routing.global && routerConfig.routing.global.default && routerConfig.routing.global.default.viaIntf || null;
    primaryWanIntfName = wanIntfNames && wanIntfNames.length > 0 ? wanIntfNames[0] : null;

    const lans = await getLANInterfaces();
    monitoringIntfNames = lans.map(i => i.config.meta.intfName);

    if (routerConfig && routerConfig.routing && routerConfig.routing.global && routerConfig.routing.global.static) {
      wanType = routerConfig.routing.global.static.type || null;
    }
  }

  async retryUntilInitComplete() {
    try {
      await this.init();
    } catch (err) {
      log.error("Failed to initialize FireRouter", err);
    }
  }

  async getWanIntfNames() {
    return wanIntfNames;
  }

  async getDefaultWanIntfName() {
    return defaultWanIntfName;
  }

  async getPrimaryWanIntfName() {
    return primaryWanIntfName;
  }

  async getWanType() {
    return wanType;
  }

  async getNetworkInfo() {
    return this.sysNetworkInfo;
  }

  async getInterface(intfName) {
    return intfNameMap[intfName] || null;
  }

  async getInterfaceByUuid(uuid) {
    return intfUuidMap[uuid] || null;
  }

  async getConfig() {
    return getConfig();
  }

  async setConfig(config) {
    return setConfig(config);
  }

  async getWANInterfaces() {
    return getWANInterfaces();
  }

  async getLANInterfaces() {
    return getLANInterfaces();
  }

  async getInterfaces() {
    return getInterfaces();
  }

  async getPowerMode() {
    return getPowerMode();
  }

  async setPowerMode(powerMode) {
    return setPowerMode(powerMode);
  }

  async getInterfaceConfig(intfName) {
    const intf = await this.getInterface(intfName);
    return intf && intf.config || null;
  }

  async getInterfaceState(intfName) {
    const intf = await this.getInterface(intfName);
    return intf && intf.state || null;
  }

  async getInterfaceType(intfName) {
    const intf = await this.getInterface(intfName);
    return intf && intf.config && intf.config.meta && intf.config.meta.type || null;
  }

  async getInterfaceNames() {
    return Object.keys(intfNameMap);
  }

  async getInterfaceUuids() {
    return Object.keys(intfUuidMap);
  }

  async getInterfaceStateByUuid(uuid) {
    const intf = await this.getInterfaceByUuid(uuid);
    return intf && intf.state || null;
  }

  async getInterfaceConfigByUuid(uuid) {
    const intf = await this.getInterfaceByUuid(uuid);
    return intf && intf.config || null;
  }

  async getInterfaceByName(intfName) {
    return this.getInterface(intfName);
  }

  async getWANInterfaceNames() {
    return this.getWanIntfNames();
  }

  async getLANInterfaceNames() {
    return monitoringIntfNames;
  }

  async getAvailableWlans() {
    const intf = platform.getDefaultWlanIntfName()
    if (!intf) return []

    return localGet(`/config/wlan/${intf}/available`, 1)
  }

  async getWlanChannels() {
    const intf = platform.getDefaultWlanIntfName()
    if (!intf) return {}

    return localGet(`/config/wlan/${intf}/channels`, 1)
  }

  async removeStaticRoutes() {
    log.debug('current routing', routerConfig.routing.global)
    if (_.get(routerConfig, 'routing.global.static')) {
      log.info('Removing static routes')
      delete routerConfig.routing.global.static
      delete routerConfig.routing.global.extra.staticRouteNotes
      delete routerConfig.routing.global.extra.staticRouteCreateDates
      await setConfig(routerConfig)
    }
  }

  async isDevelopmentVersion(branch) {
    if (branch.match(/^dev_.*/)) {
      return true
    } else {
      return false
    }
  }

  async isAlpha(branch) {
    if (branch.match(/^beta_8_.*/)) {
      return true;
    } else if (branch.match(/^beta_7_.*/)) {
      return true;
    } else {
      return false
    }
  }

  isProduction(branch) {
    if (branch.match(/^release_.*/)) {
      return true
    } else {
      return false
    }
  }

  async getBranch() {
    const fwConfig = Config.getConfig();
    const firerouterHomeFolder = `${f.getUserHome()}/${fwConfig.firerouter.homeFolder}`;
    const branch = await exec(`cd ${firerouterHomeFolder}; git rev-parse --abbrev-ref HEAD`).then((result) => result.stdout.replace(/\n/g, "")).catch((err) => {
      log.error("Failed to get branch of FireRouter", err.message);
      return null;
    });
    return branch;
  }

  async getReleaseType() {
    const branch = await this.getBranch();
    if (!branch)
      return "unknown";
    if (this.isProduction(branch)) {
      return "prod"
    } else if (this.isAlpha(branch)) {
      return "alpha";
    } else if (this.isBeta(branch)) {
      return "beta"
    } else if (this.isDevelopmentVersion(branch)) {
      return "dev"
    } else {
      return "unknown"
    }
  }

  async getAvailableWlans() {
    const intf = platform.getDefaultWlanIntfName()
    if (!intf) return []

    return localGet(`/config/wlan/${intf}/available`, 1)
  }

  async getWlanChannels() {
    const intf = platform.getDefaultWlanIntfName()
    if (!intf) return {}

    // intf doesn't matter for now in this api
    return localGet(`/config/wlan/${intf}/channels`, 1)
  }

  async removeStaticRoutes() {
    log.debug('current routing', routerConfig.routing.global)
    if (_.get(routerConfig, 'routing.global.static')) {
      log.info('Removing static routes')
      delete routerConfig.routing.global.static
      delete routerConfig.routing.global.extra.staticRouteNotes
      delete routerConfig.routing.global.extra.staticRouteCreateDates
      await setConfig(routerConfig)
    }
  }
}

const instance = new FireRouter();
Object.defineProperty(instance, "_getRaRouterLifetime", {
  value: getRaRouterLifetime
});
module.exports = instance;
