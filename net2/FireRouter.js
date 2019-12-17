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

const log = require("./logger.js")(__filename, "info");

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const BroDetect = require('./BroDetect.js');
const PlatformLoader = require('../platform/PlatformLoader.js')
const fwConfig = require('../net2/config.js').getConfig();
const pclient = require('../util/redis_manager.js').getPublishClient()

const util = require('util')
const rp = util.promisify(require('request'))

class FireRouter {
  constructor() {
    this.platform = PlatformLoader.getPlatform()

    if (!fwConfig.firerouter || !fwConfig.firerouter.interface) return null

    const intf = fwConfig.firerouter.interface;
    this.routerInterface = `http://${intf.host}:${intf.port}/${intf.version}`;
  }

  // let it crash
  async init() {
    if (this.platform.getName() == 'gold') {
      // fireroute
      this.config = await this.getConfig()

      // router -> this.getLANInterfaces()

      // simple -> this.getWANInterfaces()

    } else {
      // make sure there is at least one usable ethernet
      const Discovery = require('./Discovery.js');
      const d = new Discovery("nmap", fwConfig, "info");

      const intfList = await d.discoverInterfacesAsync()
      for (const intf of intfList) {
        this.interfaces[intf.name] = intf
      }

      // TODO
      //  create secondaryInterface
      //  start dnsmasq
      //  create fireroute compatible config

    }

    // TODO
    //  start bro service

    const bro = new BroDetect("bro_detector", fwConfig)
    bro.start()
  }

  isReady() {
    if (!this.config || !this.config.interface || !this.config.interface.phy ||
        !Object.keys(this.config.interface.phy).length)
      return false
    else
      return true
  }

  async getConfig() {
    const options = {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      url: this.routerInterface + "/config/active",
      json: true
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error("Error getting fireroute config");
    }

    return resp.body
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

  async getWANInterfaces() {
    const options = {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      url: this.routerInterface + "/config/wans",
      json: true
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error("Error getting WAN interfaces");
    }

    return resp.body
  }

  async getLANInterfaces() {
    const options = {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      url: this.routerInterface + "/config/lans",
      json: true
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error("Error getting LAN interfaces");
    }

    return resp.body
  }
}


module.exports = new FireRouter()
