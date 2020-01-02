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

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const broControl = require('./BroControl.js')
const PlatformLoader = require('../platform/PlatformLoader.js')
const Config = require('./config.js')
const rclient = require('../util/redis_manager.js').getRedisClient()
const { delay } = require('../util/util.js')
const Gold = require('../platform/gold/GoldPlatform.js')

const util = require('util')
const rp = util.promisify(require('request'))


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
    intfUuidMap[intf.meta.uuid] = intf
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
        }
      };
      await Config.updateuserconfig(updatedConfig);

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
    }

    const Discovery = require('./Discovery.js');
    const d = new Discovery("nmap");

    // updates sys:network:info
    const intfList = await d.discoverInterfacesAsync()
    if (!intfList.length) {
      throw new Error('No active ethernet!')
    }

    await broControl.restart()
    await broControl.addCronJobs()

    this.ready = true
  }

  isReady() {
    return this.ready
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
    return monitoringInterfaces.map(name => intfNameMap[name])
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
