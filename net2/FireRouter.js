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

const f = require('../net2/Firewalla.js');
const SysTool = require('../net2/SysTool.js')
const sysTool = new SysTool()
const broControl = require('./BroControl.js')
const PlatformLoader = require('../platform/PlatformLoader.js')
const Config = require('./config.js')
const rclient = require('../util/redis_manager.js').getRedisClient()
const { delay } = require('../util/util.js')
const pclient = require('../util/redis_manager.js').getPublishClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('./Message.js');
const Mode = require('./Mode.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const util = require('util')
const rp = util.promisify(require('request'))
const { Address4, Address6 } = require('ip-address')
const ip = require('ip')
const _ = require('lodash');

// not exposing these methods/properties
async function localGet(endpoint) {
  const options = {
    method: "GET",
    headers: {
      "Accept": "application/json"
    },
    url: routerInterface + endpoint,
    json: true
  };

  const resp = await rp(options)
  if (resp.statusCode !== 200) {
    throw new Error(`Error getting ${endpoint}`);
  }

  return resp.body
}

async function getConfig() {
  return localGet("/config/active")
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

function updateMaps() {
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    intf.config.meta.intfName = intfName
    intfUuidMap[intf.config.meta.uuid] = intf
  }
}

async function calculateZeekOptions(monitoringInterfaces) {
  const parentInterfaces = {};
  for (const intfName in intfNameMap) {
    if (!monitoringInterfaces.includes(intfName))
      continue;
    const intf = intfNameMap[intfName];
    const subIntfs = intf.config && intf.config.intf;
    if (!subIntfs) {
      parentInterfaces[intfName] = 1;
    } else {
      if (Array.isArray(subIntfs)) {
        // bridge interface can have multiple sub interfaces
        for (const subIntf of subIntfs) {
          const rawIntf = subIntf.split('.')[0]; // strip vlan tag if present
          parentInterfaces[rawIntf] = 1;
        }
      }
      if (typeof subIntfs === 'string') {
        const rawIntf = subIntfs.split('.')[0];
        parentInterfaces[rawIntf] = 1;
      }
    }
  }
  if (monitoringInterfaces.length <= Object.keys(parentInterfaces).length)
    return {
      listenInterfaces: monitoringInterfaces.sort(),
      restrictFilters: {}
    };
  else
    return {
      listenInterfaces: Object.keys(parentInterfaces).sort(),
      restrictFilters: {}
    };
}

function safeCheckMonitoringInterfaces(monitoringInterfaces) {
  // filter pppoe interfaces
  return monitoringInterfaces.filter(i => !i.startsWith("ppp"));
}

async function generateNetworkInfo() {
  const networkInfos = [];
  const mode = await rclient.getAsync('mode');
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    const ip4 = intf.state.ip4 ? new Address4(intf.state.ip4) : null;
    const searchDomains = (routerConfig && routerConfig.dhcp && routerConfig.dhcp[intfName] && routerConfig.dhcp[intfName].searchDomain) || [];
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
    let gateway = null;
    let gateway6 = null;
    let dns = null;
    let resolver = null;
    const resolverConfig = (routerConfig && routerConfig.dns && routerConfig.dns[intfName]) || null;
    let type = intf.config.meta.type;
    if (resolverConfig) {
      if (resolverConfig.useNameserversFromWAN) {
        const defaultRoutingConfig = routerConfig && routerConfig.routing && ((routerConfig.routing[intfName] && routerConfig.routing[intfName].default) || (routerConfig.routing.global && routerConfig.routing.global.default));
        if (defaultRoutingConfig) {
          let viaIntf = defaultRoutingConfig.viaIntf;
          if (defaultRoutingConfig === routerConfig.routing.global.default) // use default dns from global default WAN interface if no interface-specific default WAN is configured
            viaIntf = defaultWanIntfName;
          if (intfNameMap[viaIntf]) {
            resolver = intfNameMap[viaIntf].config.nameservers || intfNameMap[viaIntf].state.dns;
          }
        }
      } else {
        if (resolverConfig.nameservers)
          resolver = resolverConfig.nameservers;
      }
    }
    switch (intf.config.meta.type) {
      case "wan": {
        gateway = intf.config.gateway || intf.state.gateway;
        gateway6 = intf.config.gateway6 || intf.state.gateway6;
        dns = intf.config.nameservers || intf.state.dns;
        break;
      }
      case "lan": {
        // no gateway and dns for lan interface, gateway and dns in dhcp does not mean the same thing
        gateway = null;
        gateway6 = null;
        dns = null;
        break
      }
    }
    // always consider wan as lan in DHCP mode, which will affect port forward and VPN client
    if (mode === Mode.MODE_DHCP && type === "wan")
      type = "lan";

    const redisIntf = {
      name:         intfName,
      uuid:         intf.config.meta.uuid,
      mac_address:  intf.state.mac,
      ip_address:   ip4 ? ip4.addressMinusSuffix : null,
      subnet:       intf.state.ip4,
      netmask:      ip4 ? Address4.fromInteger(((0xffffffff << (32-ip4.subnetMask)) & 0xffffffff) >>> 0).address : null,
      gateway_ip:   gateway,
      gateway:      gateway,
      ip6_addresses: ip6s.length > 0 ? ip6s : null,
      ip6_subnets:  ip6Subnets.length > 0 ? ip6Subnets : null,
      ip6_masks:    ip6Masks.length > 0 ? ip6Masks : null,
      gateway6:     gateway6,
      dns:          dns,
      resolver:     resolver,
      // carrier:      intf.state && intf.state.carrier == 1, // need to find a better place to put this
      conn_type:    'Wired', // probably no need to keep this,
      type:         type,
      rtid:         intf.state.rtid || 0,
      searchDomains: searchDomains
    }

    if (intf.state && intf.state.wanConnState) {
      redisIntf.ready = intf.state.wanConnState.ready || false;
      redisIntf.active = intf.state.wanConnState.active || false;
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
let logicIntfNames = [];
let wanIntfNames = null
let defaultWanIntfName = null
let intfNameMap = {}
let intfUuidMap = {}


class FireRouter {
  constructor() {
    this.platform = PlatformLoader.getPlatform()
    log.info(`This platform is: ${this.platform.constructor.name}`);

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
        case Message.MSG_FR_WAN_CONN_CHANGED: {
          if (!f.isMain())
            return;
          const changeDesc = (message && JSON.parse(message)) || null;
          if (changeDesc) {
            await this.notifyWanConnChange(changeDesc);
          }
          break;
        }
        case Message.MSG_FR_IFACE_CHANGE_APPLIED : {
          log.info("Interface config is changed, schedule reload from FireRouter and restart Brofish ...");
          reloadNeeded = true;
          this.broRestartNeeded = true;
          break;
        }
        case Message.MSG_SECONDARY_IFACE_UP: {
          // this message should only be triggered on red/blue
          log.info("Secondary interface is up, schedule reload from FireRouter ...");
          reloadNeeded = true;
          break;
        }
        case Message.MSG_FR_CHANGE_APPLIED:
        case Message.MSG_NETWORK_CHANGED: {
          // these two message types should cover all proactive and reactive network changes
          log.info("Network is changed, schedule reload from FireRouter ...");
          reloadNeeded = true;
          break;
        }
        default:
      }
      if (reloadNeeded)
        this.scheduleReload();
    });

    sclient.subscribe(Message.MSG_SECONDARY_IFACE_UP);
    sclient.subscribe(Message.MSG_FR_CHANGE_APPLIED);
    sclient.subscribe(Message.MSG_NETWORK_CHANGED);
    sclient.subscribe(Message.MSG_FR_IFACE_CHANGE_APPLIED);
    sclient.subscribe(Message.MSG_FR_WAN_CONN_CHANGED);
  }

  async retryUntilInitComplete() {
    try {
      await this.init(true)
    } catch(err) {
      log.error('FireRouter failed to initialize', err)
      await delay(5000)
      this.retryUntilInitComplete()
    }
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.init().catch((err) => {
        log.error("Failed to reload init", err.message);
      });
    }, 3000);
  }

  async init(first = false) {
    let zeekOptions = {
      listenInterfaces: [],
      restrictFilters: {}
    };
    if (this.platform.isFireRouterManaged()) {
      // fireroute
      routerConfig = await getConfig()

      const mode = await rclient.getAsync('mode')

      const lastConfig = await this.loadLastConfigFromHistory();
      if (f.isMain() && (!lastConfig || ! _.isEqual(lastConfig.config, routerConfig))) {
        await this.saveConfigHistory(routerConfig);
      }

      // const wans = await getWANInterfaces();
      // const lans = await getLANInterfaces();

      // Object.assign(intfNameMap, wans, lans)
      intfNameMap = await getInterfaces()

      updateMaps()

      // extract WAN interface names
      wanIntfNames = Object.values(intfNameMap)
        .filter(intf => intf.config.meta.type == 'wan')
        .map(intf => intf.config.meta.intfName);

      // extract default route interface name
      defaultWanIntfName = null;
      if (routerConfig && routerConfig.routing && routerConfig.routing.global && routerConfig.routing.global.default) {
        const defaultRoutingConfig = routerConfig.routing.global.default;
        switch (defaultRoutingConfig.type) {
          case "primary_standby": {
            defaultWanIntfName = defaultRoutingConfig.viaIntf;
            const viaIntf = defaultRoutingConfig.viaIntf;
            const viaIntf2 = defaultRoutingConfig.viaIntf2;
            if ((intfNameMap[viaIntf] && intfNameMap[viaIntf].state && intfNameMap[viaIntf].state.wanConnState && intfNameMap[viaIntf].state.wanConnState.active === true)) {
              defaultWanIntfName = viaIntf;
            } else {
              if ((intfNameMap[viaIntf2] && intfNameMap[viaIntf2].state && intfNameMap[viaIntf2].state.wanConnState && intfNameMap[viaIntf2].state.wanConnState.active === true))
                defaultWanIntfName = viaIntf2;
            }
            break;
          }
          case "load_balance": {
            if (defaultRoutingConfig.nextHops && defaultRoutingConfig.nextHops.length > 0) {
              // load balance default route, choose the fisrt one as fallback default WAN
              defaultWanIntfName = defaultRoutingConfig.nextHops[0].viaIntf;
              for (const nextHop of defaultRoutingConfig.nextHops) {
                const viaIntf = nextHop.viaIntf;
                if (intfNameMap[viaIntf] && intfNameMap[viaIntf].state && intfNameMap[viaIntf].state.wanConnState && intfNameMap[viaIntf].state.wanConnState.active === true) {
                  defaultWanIntfName = viaIntf;
                  break;
                }
              }
            }
            break;
          }
          case "single":
          default:
            defaultWanIntfName = defaultRoutingConfig.viaIntf;
        }
      }
      if (!defaultWanIntfName )
        log.error("Default WAN interface is not defined in router config");


      log.info("adopting firerouter network change according to mode", mode)

      switch(mode) {
        case Mode.MODE_AUTO_SPOOF:
        case Mode.MODE_DHCP:
          // monitor both wan and lan in simple/DHCP mode
          monitoringIntfNames = Object.values(intfNameMap)
            .filter(intf => intf.config.meta.type === 'wan' || intf.config.meta.type === 'lan')
            .filter(intf => intf.state && intf.state.ip4) // ignore interfaces without ip address, e.g., VPN that is currently not running
            .filter(intf => intf.state && intf.state.ip4 && ip.isPrivate(intf.state.ip4.split('/')[0]))
            .map(intf => intf.config.meta.intfName);
          break;

        case Mode.MODE_NONE:
        case Mode.MODE_ROUTER:
          // only monitor lan in router mode
          monitoringIntfNames = Object.values(intfNameMap)
            .filter(intf => intf.config.meta.type === 'lan')
            .filter(intf => intf.state && intf.state.ip4)
            .map(intf => intf.config.meta.intfName);
          break;
        default:
          // do nothing for other mode
          monitoringIntfNames = [];
      }
      monitoringIntfNames = safeCheckMonitoringInterfaces(monitoringIntfNames);

      logicIntfNames = Object.values(intfNameMap)
        .filter(intf => intf.config.meta.type === 'wan' || intf.config.meta.type === 'lan')
        .filter(intf => intf.state && intf.state.ip4)
        .map(intf => intf.config.meta.intfName);

      // Legacy code compatibility
      const updatedConfig = {
        discovery: {
          networkInterfaces: monitoringIntfNames
        },
        monitoringInterface: monitoringIntfNames[0]
      };
      if (f.isMain())
        Config.updateUserConfigSync(updatedConfig);
      // update sys:network:info at the end so that all related variables and configs are already changed
      this.sysNetworkInfo = await generateNetworkInfo();
      // calculate minimal listen interfaces based on monitoring interfaces
      zeekOptions = await calculateZeekOptions(monitoringIntfNames);
    } else {
      // make sure there is at least one usable ethernet
      const networkTool = require('./NetworkTool.js')();
      // updates userConfig
      const intf = await networkTool.updateMonitoringInterface().catch((err) => {
        log.error('Error', err)
      }) || "eth0"; // a fallback for red/blue

      const intf2 = intf + ':0'

      routerConfig = {
        "interface": {
          "phy": {
            [intf]: {
              "enabled": true
            }
          }
        },
        "routing": {
          "global": {
            "default": {
              "viaIntf": intf
            }
          }
        },
        "dns": {
          "default": {
            "useNameserversFromWAN": true
          },
          [intf]: {
            "useNameserversFromWAN": true
          }
        },
        // "dhcp": {
        //   "br0": {
        //     "gateway": "10.0.0.1",
        //     "subnetMask": "255.255.255.0",
        //     "nameservers": [
        //       "10.0.0.1"
        //     ],
        //     "searchDomain": [
        //       ".lan"
        //     ],
        //     "range": {
        //       "from": "10.0.0.10",
        //       "to": "10.0.0.250"
        //     },
        //     "lease": 86400
        //   }
        // }
      }

      zeekOptions = {
        listenInterfaces: [intf],
        restrictFilters: {}
      };

      wanIntfNames = [intf];
      defaultWanIntfName = intf;

      const Discovery = require('./Discovery.js');
      const d = new Discovery("nmap");

      // regenerate stub sys:network:uuid
      const previousUUID = await rclient.hgetallAsync("sys:network:uuid") || {};
      const stubNetworkUUID = {
        "00000000-0000-0000-0000-000000000000": JSON.stringify({name: intf}),
        "11111111-1111-1111-1111-111111111111": JSON.stringify({name: intf2})
      };
      await rclient.hmset("sys:network:uuid", stubNetworkUUID);
      for (let key of Object.keys(previousUUID).filter(uuid => !Object.keys(stubNetworkUUID).includes(uuid))) {
        await rclient.hdelAsync("sys:network:uuid", key).catch(() => {});
      }
      // updates sys:network:info
      const intfList = await d.discoverInterfacesAsync()
      if (!intfList.length) {
        throw new Error('No active ethernet!')
      }

      this.sysNetworkInfo = intfList;

      const intfObj = intfList.find(i => i.name == intf)

      if (!intfObj) {
        throw new Error('Interface name not match')
      }

      const { mac_address, subnet, gateway, dns } = intfObj
      const mac = mac_address.toUpperCase();
      const v4dns = [];
      for (const dip of dns) {
        if (new Address4(dip).isValid()) {
          v4dns.push(dip);
        }
      }

      intfNameMap = { }
      intfNameMap[intf] = {
        config: {
          enabled: true,
          meta: {
            name: intf,
            uuid: '00000000-0000-0000-0000-000000000000'
          }
        },
        state: {
          mac: mac,
          ip4: subnet,
          gateway: gateway,
          dns: v4dns
        }
      }

      const wanOnPrivateIP = ip.isPrivate(intfObj.ip_address)
      monitoringIntfNames = wanOnPrivateIP ? [ intf ] : [];
      logicIntfNames = [ intf ];

      const intf2Obj = intfList.find(i => i.name == intf2)
      if (intf2Obj && intf2Obj.ip_address) {

        if (wanOnPrivateIP) monitoringIntfNames.push(intf2);
        logicIntfNames.push(intf2);
        const subnet2 = intf2Obj.subnet
        intfNameMap[intf2] = {
          config: {
            enabled: true,
            meta: {
              name: intf2,
              uuid: '11111111-1111-1111-1111-111111111111'
            }
          },
          state: {
            mac: mac,
            ip4: subnet2
          }
        }
      }
    }

    // this will ensure SysManger on each process will be updated with correct info
    sem.emitLocalEvent({type: Message.MSG_FW_FR_RELOADED});

    log.info('FireRouter initialization complete')
    this.ready = true

    if (f.isMain() && (
      // zeek used to be bro
      this.platform.isFireRouterManaged() && (broControl.optionsChanged(zeekOptions) || this.broRestartNeeded) ||
      !this.platform.isFireRouterManaged() && first
    )) {
      this.broReady = false;
      if(this.platform.isFireRouterManaged()) {
        await broControl.writeClusterConfig(zeekOptions);
      }
      // do not await bro restart to finish, it may take some time
      broControl.restart()
        .then(() => broControl.addCronJobs())
        .then(() => {
          log.info('Bro restarted');
          this.broRestartNeeded = false;
          this.broReady = true;
        });
    } else {
      this.broReady = true;
    }
  }

  isReady() {
    return this.ready
  }

  isBroReady() {
    return this.broReady
  }

  async waitTillReady() {
    if (this.ready) return

    await delay(1)
    return this.waitTillReady()
  }

  getInterfaceViaName(name) {
    if (!_.has(intfNameMap, name)) {
      return null;
    }

    return JSON.parse(JSON.stringify(intfNameMap[name]))
  }

  getInterfaceViaUUID(uuid) {
    if (!_.has(intfUuidMap, uuid)) {
      return null;
    }

    return JSON.parse(JSON.stringify(intfUuidMap[uuid]))
  }

  getInterfaceAll() {
    return JSON.parse(JSON.stringify(intfNameMap))
  }

  getLogicIntfNames() {
    return JSON.parse(JSON.stringify(logicIntfNames));
  }

  // should always be an array
  getMonitoringIntfNames() {
    return JSON.parse(JSON.stringify(monitoringIntfNames))
  }

  getWanIntfNames() {
    return JSON.parse(JSON.stringify(wanIntfNames));
  }

  getDefaultWanIntfName() {
    return defaultWanIntfName;
  }

  getConfig() {
    return JSON.parse(JSON.stringify(routerConfig))
  }

  checkConfig(newConfig) {
    // TODO: compare firerouter config and return if firewalla service/box should be restarted
    return {
      serviceRestart: false,
      systemRestart: false,
    }
  }

  async setConfig(config) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/config/set",
      json: true,
      body: config
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error("Error setting firerouter config", resp.body);
    }

    const impact = this.checkConfig(config)

    if (impact.serviceRestart) {
      sysTool.rebootServices(5)
    }

    if (impact.systemRestart) {
      sysTool.rebootSystem(5)
    }

    // do not call this.init in setConfig, make this function pure
    // await this.init()
    // init of FireRouter should be triggered by published message
    await pclient.publishAsync(Message.MSG_NETWORK_CHANGED, "");
    if (f.isApi()) {
      // reload config from lower layer to reflect change immediately in FireAPI
      routerConfig = await getConfig();
    }

    return resp.body
  }

  getSysNetworkInfo() {
    return this.sysNetworkInfo;
  }

  async saveConfigHistory(config) {
    if (!config) {
      log.error("Cannot save config, config is not specified");
      return;
    }
    const key = `history:networkConfig`;
    const time = Math.floor(Date.now() / 1000);
    await rclient.zaddAsync(key, time, JSON.stringify(config));
  }

  async loadLastConfigFromHistory() {
    const history = await this.loadRecentConfigFromHistory(1);
    if (history && history.length > 0)
      return history[0];
    else return null;
  }

  async loadRecentConfigFromHistory(count) {
    count = count || 10;
    const key = `history:networkConfig`;
    const recentConfig = await rclient.zrevrangeAsync(key, 0, count, "withscores");
    const history = [];
    if (recentConfig && recentConfig.length > 0) {
      for (let i = 0; i < recentConfig.length; i++) {
        if (i % 2 === 0) {
          const configStr = recentConfig[i];
          try {
            const config = JSON.parse(configStr);
            const time = recentConfig[i + 1];
            history.push({config, time});
          } catch (err) {
            log.error(`Failed to parse config ${configStr}`);
          }
        }
      }
    }
    return history;
  }

  async applyModeConfig() {
    if (this.platform.isFireRouterManaged()) {
      // firewalla do not change network config during mode switch if managed by firerouter
    } else {
      // red/blue, always apply network config for primary/secondary network no matter what the mode is
      const ModeManager = require('./ModeManager.js');
      await ModeManager.changeToAlternativeIpSubnet();
      await ModeManager.enableSecondaryInterface();
      await pclient.publishAsync(Message.MSG_SECONDARY_IFACE_UP, "");
    }
    // publish message to trigger firerouter init
    await pclient.publishAsync(Message.MSG_NETWORK_CHANGED, "");
  }

  async notifyWanConnChange(changeDesc) {
    if(!Config.isFeatureOn('dual_wan'))return;
    // {"intf":"eth0","ready":false,"wanSwitched":true,"currentStatus":{"eth0":{"ready":false,"active":false},"eth1":{"ready":true,"active":true}}}
    const intf = changeDesc.intf;
    const ready = changeDesc.ready;
    const wanSwitched = changeDesc.wanSwitched;
    const currentStatus = changeDesc.currentStatus;
    if (!intfNameMap[intf]) {
      log.error(`Interface ${intf} is not found`);
      return;
    }
    const activeWans = Object.keys(currentStatus).filter(i => currentStatus[i] && currentStatus[i].active).map(i => intfNameMap[i] && intfNameMap[intf].config && intfNameMap[i].config.meta && intfNameMap[i].config.meta.name).filter(name => name);
    const ifaceName = intfNameMap[intf] && intfNameMap[intf].config && intfNameMap[intf].config.meta && intfNameMap[intf].config.meta.name;
    let msg = "";
    if (!ready)
      msg = `Internet connectivity on ${ifaceName} was lost. `;
    else
      msg = `Internet connectivity on ${ifaceName} has been restored. `;
    if (activeWans.length > 0) {
      if (wanSwitched)
        msg = msg + `Active WAN is switched to ${activeWans.join(', ')}.`;
      else
        msg = msg + `Active WAN remains with ${activeWans.join(', ')}.`;
    } else {
      msg = msg + "Internet is unavailable now.";
    }
    const Alarm = require('../alarm/Alarm.js');
    const AM2 = require('../alarm/AlarmManager2.js');
    const am2 = new AM2();
    let alarm = new Alarm.DualWanAlarm(
      Date.now() / 1000,
      ifaceName,
      {
        "p.iface.name":ifaceName,
        "p.active.wans":activeWans,
        "p.wan.switched": wanSwitched,
        "p.ready": ready,
        "p.message": msg
      }
    );
    await am2.enqueueAlarm(alarm);
  }
}

const instance = new FireRouter();
module.exports = instance;
