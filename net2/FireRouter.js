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
const f = require('./Firewalla.js')
const rclient = require('../util/redis_manager.js').getRedisClient()
const { delay } = require('../util/util.js')

const util = require('util')
const rp = util.promisify(require('request'))
const exec = require('child-process-promise')

class FireRouter {
  constructor() {
    this.platform = PlatformLoader.getPlatform()

    const fwConfig = Config.getConfig();

    if (!fwConfig.firerouter || !fwConfig.firerouter.interface) return null

    const intf = fwConfig.firerouter.interface;
    this.routerInterface = `http://${intf.host}:${intf.port}/${intf.version}`;

    this.ready = false
  }

  // let it crash
  async init() {
    if (this.platform.getName() == 'gold') {
      // fireroute
      this.config = await this.getConfig()

      // router -> this.getLANInterfaces()
      // simple -> this.getWANInterfaces()

      const mode = await rclient.getAsync('mode')

      if (mode == 'spoof') {
        this.config.wans = await this.getWANInterfaces();
        this.monitoringInterfaces = Object.keys(this.config.wans)
      }
      else if (mode == 'router') {
        this.config.lans = await this.getLANInterfaces();
        this.monitoringInterfaces = Object.keys(this.config.lans)
      }

      await broControl.writeClusterConfig(this.monitoringInterfaces)

      // Update config ??
      // const updatedConfig = {
      //   discovery: {
      //     networkInterfaces: [
      //       intf,
      //       `${intf}:0`,
      //       "wlan0"
      //     ]
      //   },
      //   monitoringInterface: intf,
      //   monitoringInterface2: `${intf}:0`,
      //   secondaryInterface: secondaryInterface
      // };
      // await Config.updateUserConfig(updatedConfig);

    } else {
      // make sure there is at least one usable ethernet
      const networkTool = require('./NetworkTool.js')();
      const intf = await networkTool.updateMonitoringInterface().catch((err) => {
        log.error('Error', err)
      })

      const Discovery = require('./Discovery.js');
      const d = new Discovery("nmap", Config.getConfig(true), "info");

      const intfList = await d.discoverInterfacesAsync()
      if (!intfList.length) {
        throw new Error('No active ethernet!')
      }

      // TODO
      //  create secondaryInterface
      //  start dnsmasq
      //  create fireroute compatible config

      this.config = {
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

  async localGet(endpoint) {
    const options = {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      url: this.routerInterface + endpoint,
      json: true
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error(`Error getting ${endpoint}`);
    }

    return resp.body
  }

  async getConfig() {
    return this.localGet("/config/active")
  }

  async getWANInterfaces() {
    return this.localGet("/config/wans")
  }

  async getLANInterfaces() {
    return this.localGet("/config/lans")
  }

  async setConfig(config) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: this.routerInterface + "/config/set",
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
