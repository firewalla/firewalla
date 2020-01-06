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

const broControl = require('./BroControl.js')
const PlatformLoader = require('../platform/PlatformLoader.js')
const Config = require('./config.js')
const rclient = require('../util/redis_manager.js').getRedisClient()
const { delay } = require('../util/util.js')
const Gold = require('../platform/gold/GoldPlatform.js')

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

function updateMaps() {
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    intf.config.meta.name = intfName
    intfUuidMap[intf.config.meta.uuid] = intf
  }
  for (const type in routerConfig.interface) {
    for (const intfName in routerConfig[type]) {
      if (intfNameMap[intfName]) {
        intfNameMap[intfName].config.meta.type = type
      }
    }
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
      dns:          intf.config.dhcp ? intf.config.dhcp.dns : intf.state.dns,
      type:         'Wired', // probably no need to keep this
    }

    await rclient.hsetAsync('sys:network:info', intfName, JSON.stringify(redisIntf))
    await rclient.hsetAsync('sys:network:uuid', redisIntf.uuid, JSON.stringify(redisIntf))
  }
}

let routerInterface = null
let routerConfig = null
let monitoringInterfaces = null
let intfNameMap = {}
let intfUuidMap = {}


class FireRouter {
  constructor() {
    this.platform = PlatformLoader.getPlatform()

    const fwConfig = Config.getConfig();

    if (!fwConfig.firerouter || !fwConfig.firerouter.interface) return null

    const intf = fwConfig.firerouter.interface;
    routerInterface = `http://${intf.host}:${intf.port}/${intf.version}`;

    this.ready = false

    this.isFireMain = process.title === 'FireMain';

    this.init().catch(err => {
      log.error('FireRouter failed to initialize', err)
      process.exit(1);
    })
  }

  // let it crash
  async init() {
    if (this.platform instanceof Gold) {
      // fireroute
      routerConfig = await getConfig()

      const mode = await rclient.getAsync('mode')

      const wans = await getWANInterfaces();
      const lans = await getLANInterfaces();

      Object.assign(intfNameMap, wans, lans)

      updateMaps()

      await generateNetowrkInfo()

      if (mode == 'spoof') {
        monitoringInterfaces = Object.keys(wans)
      }
      else if (mode == 'router') {
        monitoringInterfaces = Object.keys(lans)
      }

      await broControl.writeClusterConfig(monitoringInterfaces)

      // Keep Discovery.discoverMac() working
      // TODO: is this necessary?
      const updatedConfig = {
        discovery: {
          networkInterfaces: monitoringInterfaces
        },
        monitoringInterface: monitoringInterfaces[0]
      };
      await Config.updateUserConfig(updatedConfig);


    } else {
      // make sure there is at least one usable ethernet
      const networkTool = require('./NetworkTool.js')();
      // updates userConfig
      const intf = await networkTool.updateMonitoringInterface().catch((err) => {
        log.error('Error', err)
      })


      // TODO
      //  create secondaryInterface
      //  start dnsmasq
      //  create fireroute compatible config

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

      monitoringInterfaces = [ 'eth0', 'eth0:0' ]

      const Discovery = require('./Discovery.js');
      const d = new Discovery("nmap");

      // updates sys:network:info
      const intfList = await d.discoverInterfacesAsync()
      if (!intfList.length) {
        throw new Error('No active ethernet!')
      }
    }

    this.ready = true

    if (this.isFireMain) {
      await broControl.restart()
      await broControl.addCronJobs()
    }

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
    return intfNameMap[name]
  }

  getInterfaceViaUUID(uuid) {
    return intfUuidMap[uuid]
  }

  getMonitoringInterfaces() {
    return monitoringInterfaces
  }

  getConfig() {
    return routerConfig
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
      throw new Error("Error getting fireroute config", resp.body);
    }

    return resp.body
  }

}


module.exports = new FireRouter()
