/*    Copyright 2019-2022 Firewalla Inc.
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

const util = require('util')
const rp = util.promisify(require('request'))
const { Address4, Address6 } = require('ip-address')
const _ = require('lodash');
const exec = require('child-process-promise').exec;
const era = require('../event/EventRequestApi.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_INIT = "LOCK_INIT";

// not exposing these methods/properties
async function localGet(endpoint, retry = 10) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  while (retry > 0) {
    try {
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
        throw new Error(`Error getting ${endpoint}, code: ${resp.statusCode}`);
      }

      return resp.body
    } catch (err) {
      if (--retry > 0) {
        log.warn(`${err.message}, try again in 2s...`)
        await delay(2000);
      } else {
        log.error(`${err.message}, out of retries`)
        throw err
      }
    }
  }
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

async function generateNetworkInfo() {
  const networkInfos = [];
  const mode = await rclient.getAsync('mode');
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    const ip4 = intf.state.ip4 ? new Address4(intf.state.ip4) : null;
    const searchDomains = (routerConfig && routerConfig.dhcp && routerConfig.dhcp[intfName] && routerConfig.dhcp[intfName].searchDomain) || [];
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
    let gateway = null;
    let gateway6 = null;
    let dns = null;
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
      ip4_addresses: ip4s.length > 0 ? ip4s : null,
      ip4_subnets:  ip4Subnets.length > 0 ? ip4Subnets : null,
      ip4_masks:    ip4Masks.length > 0 ? ip4Masks : null,
      ip6_addresses: ip6s.length > 0 ? ip6s : null,
      ip6_subnets:  ip6Subnets.length > 0 ? ip6Subnets : null,
      ip6_masks:    ip6Masks.length > 0 ? ip6Masks : null,
      gateway6:     gateway6,
      dns:          dns,
      resolver:     resolver,
      resolverFromWan: resolverFromWan,
      // carrier:      intf.state && intf.state.carrier == 1, // need to find a better place to put this
      conn_type:    'Wired', // probably no need to keep this,
      type:         type,
      rtid:         intf.state.rtid || 0,
      searchDomains: searchDomains
    }

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
        case Message.MSG_FR_IFACE_CHANGE_APPLIED : {
          log.info("Interface config is changed, schedule reload from FireRouter and restart Pcap tool ...");
          reloadNeeded = true;
          this.pcapRestartNeeded = true;
          this.tcFilterRefreshNeeded = true;
          break;
        }
        case Message.MSG_SECONDARY_IFACE_UP: {
          // this message should only be triggered on red/blue
          log.info("Secondary interface is up, schedule reload from FireRouter ...");
          reloadNeeded = true;
          this.pcapRestartNeeded = true;
          break;
        }
        case Message.MSG_FR_CHANGE_APPLIED:
        case Message.MSG_NETWORK_CHANGED: {
          // these two message types should cover all proactive and reactive network changes
          log.info("Network is changed, schedule reload from FireRouter ...");
          reloadNeeded = true;
          this.pcapRestartNeeded = true;
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
    await lock.acquire(LOCK_INIT, async () => {
      const routingWans = [];
      if (platform.isFireRouterManaged()) {
        // fireroute
        routerConfig = await getConfig()

        const mode = await rclient.getAsync('mode')

        const lastConfig = await this.loadLastConfigFromHistory();
        if (f.isMain() && (!lastConfig || !_.isEqual(lastConfig.config, routerConfig))) {
          await this.saveConfigHistory(routerConfig);
        }

        // const wans = await getWANInterfaces();
        // const lans = await getLANInterfaces();

        // Object.assign(intfNameMap, wans, lans)
        let intfInfoComplete = false;
        while (!intfInfoComplete) {
          intfNameMap = await getInterfaces()
          intfInfoComplete = updateMaps();
          if (!intfInfoComplete) {
            log.warn("Interface information is incomplete from config/interfaces, will try again later");
            await delay(2000);
          }
        }

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
              if (viaIntf)
                routingWans.push(viaIntf);
              if (viaIntf2)
                routingWans.push(viaIntf2);
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
                let activeWanFound = false;
                for (const nextHop of defaultRoutingConfig.nextHops) {
                  const viaIntf = nextHop.viaIntf;
                  routingWans.push(viaIntf);
                  if (intfNameMap[viaIntf] && intfNameMap[viaIntf].state && intfNameMap[viaIntf].state.wanConnState && intfNameMap[viaIntf].state.wanConnState.active === true && !activeWanFound) {
                    defaultWanIntfName = viaIntf;
                    activeWanFound = true;
                  }
                }
              }
              break;
            }
            case "single":
            default:
              defaultWanIntfName = defaultRoutingConfig.viaIntf;
              routingWans.push(defaultRoutingConfig.viaIntf);
          }
        }
        if (!defaultWanIntfName)
          log.error("Default WAN interface is not defined in router config");


        log.info("adopting firerouter network change according to mode", mode)
        // do not load br_netfilter except for bridge mode or dev/alpha/beta branch, this module will cause packet drop while being redirected to ifb device in kernel later than 5.4.0-89
        if (!f.isProduction() ||
          (mode === Mode.MODE_DHCP && defaultWanIntfName.startsWith("br"))) {
          await exec(`sudo modprobe br_netfilter`).catch((err) => { });
        } else {
          await exec(`sudo rmmod br_netfilter`).catch((err) => { });
        }

        switch (mode) {
          case Mode.MODE_AUTO_SPOOF:
          case Mode.MODE_DHCP:
            // monitor both wan and lan in simple/DHCP mode
            monitoringIntfNames = Object.values(intfNameMap)
              .filter(intf => intf.config.meta.type === 'wan' || intf.config.meta.type === 'lan')
              .filter(intf => intf.state && intf.state.ip4) // ignore interfaces without ip address, e.g., VPN that is currently not running
              .filter(intf => intf.state && intf.state.ip4)
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
          .filter(intf => intf.config.meta.type === 'wan' || intf.state && intf.state.ip4) // still show WAN interface without an IP address in logic interfaces
          .map(intf => intf.config.meta.intfName);

        // update sys:network:info at the end so that all related variables and configs are already changed
        this.sysNetworkInfo = await generateNetworkInfo();
      } else {
        // make sure there is at least one usable ethernet
        const networkTool = require('./NetworkTool.js')();
        // updates userConfig, but only update config.json in main
        const intf = await networkTool.updateMonitoringInterface(f.isMain()).catch((err) => {
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

        wanIntfNames = [intf];
        defaultWanIntfName = intf;

        const Discovery = require('./Discovery.js');
        const d = new Discovery("nmap");

        // regenerate stub sys:network:uuid
        const previousUUID = await rclient.hgetallAsync("sys:network:uuid") || {};
        const stubNetworkUUID = {
          "00000000-0000-0000-0000-000000000000": JSON.stringify({ name: intf }),
          "11111111-1111-1111-1111-111111111111": JSON.stringify({ name: intf2 })
        };
        await rclient.hmsetAsync("sys:network:uuid", stubNetworkUUID);
        for (let key of Object.keys(previousUUID).filter(uuid => !Object.keys(stubNetworkUUID).includes(uuid))) {
          await rclient.hdelAsync("sys:network:uuid", key).catch(() => { });
        }
        // updates sys:network:info
        const intfList = await d.discoverInterfacesAsync()
        if (!intfList.length) {
          throw new Error('No active ethernet!');
        }

        this.sysNetworkInfo = intfList;

        // make data in sys:network:uuid consistent with sys:network:info
        for (const uuid of Object.keys(stubNetworkUUID)) {
          const intfObj = intfList.find(i => i.uuid === uuid);
          if (!_.isEmpty(intfObj))
            await rclient.hsetAsync("sys:network:uuid", uuid, JSON.stringify(intfObj));
        }

        const intfObj = intfList.find(i => i.name == intf)

        if (!intfObj) {
          throw new Error('Interface name not match');
        }

        const { mac_address, subnet, gateway, dns } = intfObj
        const mac = mac_address.toUpperCase();
        const v4dns = [];
        for (const dip of dns) {
          if (new Address4(dip).isValid()) {
            v4dns.push(dip);
          }
        }

        intfNameMap = {}
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

        // const wanOnPrivateIP = ip.isPrivate(intfObj.ip_address)
        // need to think of a better way to check wan on private network
        // monitoringIntfNames = wanOnPrivateIP ? [ intf ] : [];
        monitoringIntfNames = [intf];
        logicIntfNames = [intf];

        const intf2Obj = intfList.find(i => i.name == intf2)
        if (intf2Obj && intf2Obj.ip_address) {

          //if (wanOnPrivateIP)
          // need to think of a better way to check wan on private network
          monitoringIntfNames.push(intf2);
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
      sem.emitLocalEvent({ type: Message.MSG_FW_FR_RELOADED });

      log.info('FireRouter initialization complete')
      this.ready = true

      if (f.isMain()) {
        // zeek used to be bro
        if (this.pcapRestartNeeded || !platform.isFireRouterManaged() && first) {
          sem.emitLocalEvent({ type: Message.MSG_PCAP_RESTART_NEEDED });
          this.pcapRestartNeeded = false;
        }
        if (first || this.tcFilterRefreshNeeded) {
          const localIntfs = monitoringIntfNames.filter(iface => intfNameMap[iface] && intfNameMap[iface].config.meta.type === 'lan');
          await this.resetTCFilters(localIntfs);
          this.tcFilterRefreshNeeded = false;
        }
        if (platform.isFireRouterManaged()) {
          // overall_wan_state event
          const wanType = (routerConfig && routerConfig.routing && routerConfig.routing.global && routerConfig.routing.global.default && routerConfig.routing.global.default.type) || "single";
          let stateVal = 0;
          const currentStatus = {};
          let pendingTest = false;
          for (const i in routingWans.sort()) {
            const iface = routingWans[i];
            const wanConnState = intfNameMap[iface] && intfNameMap[iface].state && intfNameMap[iface].state.wanConnState;
            currentStatus[iface] = {
              ready: wanConnState && wanConnState.ready || false,
              active: wanConnState && wanConnState.active || false,
              wan_intf_name: intfNameMap[iface] && intfNameMap[iface].config && intfNameMap[iface].config.meta && intfNameMap[iface].config.meta.name,
              wan_intf_uuid: intfNameMap[iface] && intfNameMap[iface].config && intfNameMap[iface].config.meta && intfNameMap[iface].config.meta.uuid
            };
            if (currentStatus[iface].ready !== true)
              stateVal += (1 << i);
            if (wanConnState && wanConnState.pendingTest)
              pendingTest = true;
            else {
              const failures = intfNameMap[iface] && intfNameMap[iface].state && intfNameMap[iface] && intfNameMap[iface].state.wanTestResult && intfNameMap[iface] && intfNameMap[iface].state.wanTestResult.failures || [];
              era.addStateEvent("wan_state", iface, wanConnState && wanConnState.ready ? 0 : 1, Object.assign({}, currentStatus[iface], {failures}));
            }
          }
          // ready/active may be inaccurate if pendingTest is true, another wan conn change event will be fired from firerouter once pendingTest is cleared
          if (!pendingTest) {
            era.addStateEvent("overall_wan_state", "overall_wan_state", stateVal, { wanStatus: currentStatus, wanType: wanType }).catch((err) => {
              log.error(`Failed to create overall_wan_state event`, err.message);
            });
          }
        }
      }
    });
  }

  async resetTCFilters(ifaces) {
    if (!platform.isIFBSupported()) {
      log.info("Platform does not support ifb, tc filters will not be reset");
      return;
    }
    if (this._qosIfaces) {
      log.info("Clearing tc filters ...", this._qosIfaces);
      for (const iface of this._qosIfaces) {
        await exec(`sudo tc qdisc del dev ${iface} root`).catch(() => {});
        await exec(`sudo tc qdisc del dev ${iface} ingress`).catch(() => {});
      }
    }
    log.info("Initializing tc filters ...", ifaces);
    for (const iface of ifaces) {
      await exec(`sudo tc qdisc del dev ${iface} root`).catch(() => { });
      await exec(`sudo tc qdisc del dev ${iface} ingress`).catch(() => { });
    }

    await platform.reloadActMirredKernelModule();

    for (const iface of ifaces) {
      await exec(`sudo tc qdisc add dev ${iface} ingress`).catch((err) => {
        log.error(`Failed to create ingress qdisc on ${iface}`, err.message);
      });
      await exec(`sudo tc qdisc replace dev ${iface} root handle 1: htb default 1`).catch((err) => {
        log.error(`Failed to create default htb qdisc on ${iface}`, err.message);
      })
      // only redirect ipv4 and ipv6 traffic to ifb devices, prevent 802.1q packets from being redirected to ifb twice
      // redirect ingress (upload) traffic to ifb0, egress (download) traffic to ifb1
      for (const {dir, parent, ifb, mask} of [{dir: "upload", parent: "ffff:", ifb: "ifb0", mask: QoS.QOS_UPLOAD_MASK}, {dir: "download", parent: "1:", ifb: "ifb1", mask: QoS.QOS_DOWNLOAD_MASK}]) {
        for (const {proto, ht, prio} of [{proto: "ip", ht: 800, prio: 1}, {proto: "ipv6", ht: 801, prio: 2}]) {
          const cmds = [
            `sudo tc filter add dev ${iface} parent ${parent} handle ${ht}::0x1 prio ${prio} protocol ${proto} u32 match u32 0 0 action connmark continue`,
            `sudo tc filter add dev ${iface} parent ${parent} handle ${ht}::0x2 prio ${prio} protocol ${proto} u32 match mark 0x0 ${mask} action pass`,
            `sudo tc filter add dev ${iface} parent ${parent} handle ${ht}::0x3 prio ${prio} protocol ${proto} u32 match u32 0 0 action mirred egress redirect dev ${ifb} pass`
          ];
          for (const cmd of cmds) {
            await exec(cmd).catch((err) => {
              log.error(`Failed to add tc filter for ${proto} ${dir} traffic on ${iface}, ${cmd}`, err.message);
            });
          }
        }
      }
    }
    this._qosIfaces = ifaces;
  }

  async getWanConnectivity(live = false) {
    if(live) {
      return localGet("/config/wan/connectivity?live=true");
    } else {
      return localGet("/config/wan/connectivity");
    }
  }

  async getSystemWANInterfaces() {
    return getWANInterfaces();
  }

  isReady() {
    return this.ready
  }

  isBroReady() {
    return this.broReady
  }

  async waitTillReady() {
    if (this.ready) return

    await delay(1000)
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

  async getInterfaceAll(live = false) {
    if (live) {
      return getInterfaces();
    } else {
      return JSON.parse(JSON.stringify(intfNameMap))
    }
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

  async getConfig(reload = false) {
    if (reload) {
      routerConfig = await getConfig();
    }
    return JSON.parse(JSON.stringify(routerConfig))
  }

  checkConfig(newConfig) {
    // TODO: compare firerouter config and return if firewalla service/box should be restarted
    return {
      serviceRestart: false,
      systemRestart: false,
    }
  }

  async switchBranch(target) {
    let tgt = null;
    switch (target) {
      case "dev":
        tgt = "master";
        break;
      case "alpha":
      case "salpha":
        tgt = "alpha";
        break;
      case "beta":
        tgt = "beta";
        break;
      case "prod":
        tgt = "release";
        break;
      default:
    }
    if (!tgt) {
      log.error(`Cannot find corresponding firerouter target branch for ${target}`);
      return;
    }
    log.info(`Going to switch to firerouter branch ${tgt}`);
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/system/switch_branch",
      json: true,
      body: {
        target: tgt
      }
    }
    const resp = await rp(options);
    if (resp.statusCode !== 200) {
      throw new Error(`Failed to switch firerouter branch to ${target}`);
    }

    this.scheduleRestartFireBoot();
    return resp.body;
  }

  scheduleRestartFireBoot(delay = 10) {
    setTimeout(() => {
      exec("rm -f /dev/shm/firerouter.prepared; sudo systemctl restart firerouter; sudo systemctl restart firereset").then(() => exec(`sudo systemctl restart fireboot`));
    }, delay * 1000);
  }

  async saveTextFile(filename, content) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/storage/save_txt_file",
      json: true,
      body: {
        filename: filename,
        content: content
      }
    };
    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error(`Error save text file ${filename}`, resp.body);
    }
    return resp.body;
  }

  async loadTextFile(filename) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/storage/load_txt_file",
      json: true,
      body: {
        filename: filename
      }
    };
    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error(`Error load text file ${filename}`, resp.body);
    }
    return resp.body && resp.body.content;
  }

  async removeFile(filename) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/storage/remove_file",
      json: true,
      body: {
        filename: filename
      }
    };
    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error(`Error remove text file ${filename}`, resp.body);
    }
    return resp.body;
  }

  async getFilenames() {
    return localGet("/storage/filenames").then(resp => resp.filenames);
  }

  async switchWifi(iface, ssid, params = {}) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/config/wlan/switch_wifi/" + iface,
      json: true,
      body: {
        ssid: ssid,
        params: params
      }
    };
    const resp = await rp(options)
    switch (resp.statusCode) {
      case 200:
      case 400:
        return resp.body;
      default:
        throw new Error(`Failed to switch wifi on ${iface} to ${ssid}`);
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
    if (platform.isFireRouterManaged()) {
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
    // {
    //   "intf": "eth0",
    //   "ready": false,
    //   "wanSwitched": true,
    //   "currentStatus": {
    //     "eth0": {
    //       "ready":false,
    //       "active":false，
    //       "wan_intf_name": "ISP 1",
    //       "wan_intf_uuid": "xxxxxx"
    //     },
    //     "eth1": {
    //       "ready":true,
    //       "active":true,
    //       "wan_intf_name": "ISP 2",
    //       "wan_intf_uuid": "yyyyyy"
    //     }
    //   }
    // }
    const intf = changeDesc.intf;
    const ready = changeDesc.ready;
    const wanSwitched = changeDesc.wanSwitched;
    const currentStatus = changeDesc.currentStatus;
    const failures = changeDesc.failures;
    if (!currentStatus[intf]) {
      log.error(`Interface ${intf} is not found in currentStatus of changeDesc`);
      return;
    }
    const activeWans = Object.keys(currentStatus).filter(i => currentStatus[i] && currentStatus[i].active).map(i => currentStatus[i].wan_intf_name);
    const readyWans = Object.keys(currentStatus).filter(i => currentStatus[i] && currentStatus[i].ready).map(i => currentStatus[i].wan_intf_name);
    const ifaceName = currentStatus[intf] && currentStatus[intf].wan_intf_name;
    const type = (routerConfig && routerConfig.routing && routerConfig.routing.global && routerConfig.routing.global.default && routerConfig.routing.global.default.type) || "single";

    if (type !== 'single') {
      // dualwan_state event
      log.debug("dual WAN");
      log.debug("enrichedWanStatus=", currentStatus);
      const wanIntfs = Object.keys(currentStatus);
      // calcuate state value based on active/ready status of both WANs
      let dualWANStateValue =
        (currentStatus[wanIntfs[0]].active ? 0 : 1) +
        (currentStatus[wanIntfs[0]].ready ? 0 : 2) +
        (currentStatus[wanIntfs[1]].active ? 0 : 4) +
        (currentStatus[wanIntfs[1]].ready ? 0 : 8);
      log.debug("original state value=", dualWANStateValue);
      /*
        * OK state
        * - Failover   : both ready, and primary active but standby inactive, or either active if failback
        * - LoadBalance: both active and ready
        */
      let labels = {
        "changedInterface": intf,
        "wanSwitched": wanSwitched,
        "wanType": type,
        "wanStatus": currentStatus
      };
      if (type === 'primary_standby' &&
        routerConfig &&
        routerConfig.routing &&
        routerConfig.routing.global &&
        routerConfig.routing.global.default &&
        routerConfig.routing.global.default.viaIntf) {
        const primaryInterface = routerConfig.routing.global.default.viaIntf;
        const failback = routerConfig.routing.global.default.failback || false;
        labels.primaryInterface = primaryInterface;
        if (failback) {
          if ((primaryInterface === wanIntfs[1] && dualWANStateValue === 1) ||
            (primaryInterface === wanIntfs[0] && dualWANStateValue === 4)) {
            dualWANStateValue = 0;
          }
        } else if ((dualWANStateValue === 1) || (dualWANStateValue === 4)) {
          dualWANStateValue = 0;
        }
      }
      log.debug("labels=", labels);
      era.addStateEvent("dualwan_state", type, dualWANStateValue, labels);
      log.debug("sent dualwan_state event");
    }

    // wan_state event
    try {
      era.addStateEvent("wan_state", intf, ready ? 0 : 1, Object.assign({}, currentStatus[intf], { failures }));
      log.debug("sent wan_state event");
    } catch (err) {
      log.error(`failed to create wan_state event for ${intf}:`, err);
    }

    if (changeDesc.noNotify === true)
      return;
    if (type === "single" && !Config.isFeatureOn('single_wan_conn_check')) {
      log.warn("Single WAN connectivity check is not enabled, ignore conn change event", changeDesc);
      return;
    }
    let msg = "";
    if (!ready)
      msg = `Internet connectivity on ${ifaceName} was lost.`;
    else
      msg = `Internet connectivity on ${ifaceName} has been restored.`;
    if (type !== "single") { // do not add WAN switch information for single WAN configuration
      if (activeWans.length > 0) {
        if (wanSwitched)
          msg = msg + ` Active WAN is switched to ${activeWans.join(', ')}.`;
        else
          msg = msg + ` Active WAN remains with ${activeWans.join(', ')}.`;
      } else {
        msg = msg + " Internet is unavailable now.";
      }
    }
    if (Config.isFeatureOn('dual_wan')) {
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
          "p.wan.type": type,
          "p.ready": ready,
          "p.failures": failures,
          "p.message": msg
        }
      );
      am2.enqueueAlarm(alarm);
    }
  }

  isDevelopmentVersion(branch) {
    if (branch === "master" || branch.includes("master")) {
      return true
    } else {
      return false
    }
  }

  isBeta(branch) {
    if (branch.match(/^beta_.*/)) {
      if (this.isAlpha(branch)) {
        return false;
      }
      return true;
    } else {
      return false
    }
  }

  isAlpha(branch) {
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
}

const instance = new FireRouter();
module.exports = instance;
