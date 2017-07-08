/*    Copyright 2016 Firewalla LLC
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

let log = require('./logger.js')(__filename);

let Promise = require('bluebird');

let linux = require('../util/linux.js');

let fConfig = require('../net2/config.js').getConfig();

let os = require('os');
let ip = require('ip');
let dns = require('dns');

let instance = null;
class NetworkTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  _is_interface_valid(netif) {
    return netif.ip_address != null && netif.mac_address != null && netif.type != null && !netif.ip_address.startsWith("169.254.");
  }

  _getSubnet(networkInterface, family) {
    this.networkInterfaces = os.networkInterfaces();
    let interfaceData = this.networkInterfaces[networkInterface];
    if (interfaceData == null) {
      return null;
    }

    var ipSubnets = [];


    for (let i = 0; i < interfaceData.length; i++) {
      if (interfaceData[i].family == family && interfaceData[i].internal == false) {
        let subnet = ip.subnet(interfaceData[i].address, interfaceData[i].netmask);
        let subnetmask = subnet.networkAddress + "/" + subnet.subnetMaskLength;
        ipSubnets.push(subnetmask);
      }
    }

    return ipSubnets;

  }
  
  listInterfaces() {
    return new Promise((resolve, reject) => {
      
      linux.get_network_interfaces_list((err, list) => {
        if (list == null || list.length <= 0) {
          log.error("Discovery::Interfaces", "No interfaces found");
          resolve([]);
          return;
        }

        list = list.filter(this._is_interface_valid);

        list.forEach((i) => {
          log.info("Found interface %s %s", i.name, i.ip_address);

          i.gateway = require('netroute').getGateway(i.name);
          i.subnet = this._getSubnet(i.name, 'IPv4');
          i.gateway6 = linux.gateway_ip6_sync();
          if (i.subnet.length > 0) {
            i.subnet = i.subnet[0];
          }
          i.dns = dns.getServers();
        });
      
        resolve(list);
      });
    });
  }
  
  getLocalNetworkInterface() {
    let intfs = fConfig.discovery && fConfig.discovery.networkInterfaces;
    if(!intfs) {
      return Promise.resolve(null);
    }
    
    return this.listInterfaces()
      .then((list) => {
        let list2 = list.filter((x) => {
          return intfs.filter((y) => y === x.name).length > 0;
        });
        if(list2.length === 0) {
          return Promise.resolve(null);
        } else {
          return list2[0];
        }
      });
  }
}

module.exports = function() {
  return new NetworkTool();
};