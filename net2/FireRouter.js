/*    Copyright 2019 Firewalla Inc.
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

const util = require('util')
const rp = util.promisify(require('request'))
const { Address4, Address6 } = require('ip-address')


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
    intf.config.meta.name = intfName
    intfUuidMap[intf.config.meta.uuid] = intf
  }
  for (const intfName in routerConfig.dhcp) {
    if (intfNameMap[intfName]) {
      intfNameMap[intfName].config.dhcp = routerConfig.dhcp[intfName]
    }
  }
}

async function generateNetowrkInfo() {
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    const ip4 = new Address4(intf.state.ip4)
    const redisIntf = {
      name:         intfName,
      uuid:         intf.config.meta.uuid,
      mac_address:  intf.state.mac,
      ip_address:   ip4.addressMinusSuffix,
      subnet:       intf.state.ip4,
      netmask:      Address4.fromInteger(((0xffffffff << (32-ip4.subnetMask)) & 0xffffffff) >>> 0).address,
      gateway_ip:   intf.config.dhcp ? intf.config.dhcp.gateway : intf.state.gateway,
      dns:          intf.config.dhcp ? intf.config.dhcp.nameservers : intf.state.dns,
      type:         'Wired', // probably no need to keep this
    }

    await rclient.hsetAsync('sys:network:info', intfName, JSON.stringify(redisIntf))
    await rclient.hsetAsync('sys:network:uuid', redisIntf.uuid, JSON.stringify(redisIntf))
  }
}

let routerInterface = null
let routerConfig = null
let monitoringIntfNames = null
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

    this.init(true).catch(err => {
      log.error('FireRouter failed to initialize', err)
      process.exit(1);
    })
  }

  // let it crash
  async init(first = false) {
    if (this.platform.isFireRouterManaged()) {
      // fireroute
      routerConfig = await getConfig()

      const mode = await rclient.getAsync('mode')

      // const wans = await getWANInterfaces();
      // const lans = await getLANInterfaces();

      // Object.assign(intfNameMap, wans, lans)
      intfNameMap = await getInterfaces()

      updateMaps()

      await generateNetowrkInfo()

      switch(mode) {
        case 'spoof':
          monitoringIntfNames = Object.values(intfNameMap)
            .filter(intf => intf.config.meta.type == 'wan')
            .map(intf => intf.config.meta.name)
          break;

        default: // router mode
          monitoringIntfNames = Object.values(intfNameMap)
            .filter(intf => intf.config.meta.type == 'lan')
            .map(intf => intf.config.meta.name)
          break
      }

      // Legacy code compatibility
      const updatedConfig = {
        discovery: {
          networkInterfaces: monitoringIntfNames
        },
        monitoringInterface: monitoringIntfNames[0]
      };
      Config.updateUserConfigSync(updatedConfig);

    } else {
      // make sure there is at least one usable ethernet
      const networkTool = require('./NetworkTool.js')();
      // updates userConfig
      const intf = await networkTool.updateMonitoringInterface().catch((err) => {
        log.error('Error', err)
      })

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

      // intfNameMap = {
      //   eth0: {
      //     config: {
      //       enabled: true,
      //       meta: {
      //         name: 'eth0',
      //         uuid: uuid.v4(),
      //       }
      //     },
      //     state: {
      //       mac: 'a2:c6:b7:a9:4b:f7',
      //       ip4: '',
      //       gateway: '',
      //       dns: null
      //     }
      //   }
      // }

      monitoringIntfNames = [ 'eth0', 'eth0:0' ]

      const Discovery = require('./Discovery.js');
      const d = new Discovery("nmap");

      // updates sys:network:info
      const intfList = await d.discoverInterfacesAsync()
      if (!intfList.length) {
        throw new Error('No active ethernet!')
      }
    }

    log.info('FireRouter initialization complete')
    this.ready = true

    if (f.isMain() && (
      this.platform.isFireRouterManaged() && broControl.interfaceChanged(monitoringIntfNames) ||
      !this.platform.isFireRouterManaged() && first
    )) {
      if(this.platform.isFireRouterManaged()) {
        await broControl.writeClusterConfig(monitoringIntfNames)
      }
      await broControl.restart()
      await broControl.addCronJobs()
    }

    log.info('Bro restarted')
    this.broReady = true
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
    return JSON.parse(JSON.stringify(intfNameMap[name]))
  }

  getInterfaceViaUUID(uuid) {
    return JSON.parse(JSON.stringify(intfUuidMap[uuid]))
  }

  getInterfaceAll() {
    return JSON.parse(JSON.stringify(intfNameMap))
  }

  getMonitoringIntfNames() {
    return JSON.parse(JSON.stringify(monitoringIntfNames))
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

  // call checkConfig() for the impact before actually commit it
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
      throw new Error("Error getting fireroute config", resp.body);
    }

    const impact = this.checkConfig(config)

    if (impact.serviceRestart) {
      sysTool.rebootServices(5)
    }

    if (impact.systemRestart) {
      sysTool.rebootSystem(5)
    }

    this.init()

    return resp.body
  }

}

const instance = new FireRouter();
module.exports = instance;
