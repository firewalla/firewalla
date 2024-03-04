/*    Copyright 2016-2022 Firewalla Inc.
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

const log = require('./logger.js')(__filename);

const linux = require('../util/linux.js');

const Config = require('./config.js');
let fConfig = Config.getConfig();

const os = require('os');
const ip = require('ip');
const dns = require('dns');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const exec = require('child-process-promise').exec

let instance = null;

class NetworkTool {
  constructor() {
    if (!instance) {
      instance = this;
    }
    return instance;
  }

  async updateMonitoringInterface(updateFile = true) {
    const cmd = "/sbin/ip route show | awk '/default via/ {print $5}' | head -n 1"
    const result = await exec(cmd).catch((err) => null);
    fConfig = await Config.getConfig(true);
    if (result && result.stdout) {
      const intf = result.stdout.trim();
      const secondaryInterface = fConfig.secondaryInterface;
      secondaryInterface.intf = `${intf}:0`;
      const updatedConfig = {
        discovery: {
          networkInterfaces: [
            intf,
            `${intf}:0`,
            "wlan0"
          ]
        },
        monitoringInterface: intf,
        monitoringInterface2: `${intf}:0`,
        secondaryInterface: secondaryInterface
      };
      log.info('MonitoringInterface:', intf)
      await Config.updateUserConfig(updatedConfig, updateFile);
      fConfig = Config.getConfig();

      return intf
    } else {
      log.error("WAN interface is not detected");
      return null
    }
  }

  _is_interface_valid(netif) {
    return (
      netif.ip_address != null &&
      netif.mac_address != null &&
      netif.conn_type != null &&
      !netif.ip_address.startsWith('169.254.')
    );
  }

  // returns CIDR or null
  _getSubnet(interfaceName, ipAddress, family) {
    let interfaceData = os.networkInterfaces()[interfaceName];
    if (interfaceData == null) {
      return null
    }

    var ipSubnets = [];

    interfaceData.forEach(osIf => {
      if (osIf.family == family && osIf.address == ipAddress && !osIf.internal && osIf.cidr != null) {
        ipSubnets.push(osIf.cidr);
      }
    });

    return ipSubnets[0];
  }

  async getIdentifierMAC() {
    // eth0 is default WAN interface for red, blue and gold.
    // It is hardcoded. But it fits for red, blue and gold. It may not be changed in a long time
    const iface = "eth0";
    const result = await exec(`cat /sys/class/net/${iface}/address`).catch((err) => { return null });
    if (result) {
      const mac = result.stdout.trim();
      return mac;
    }
    return null;
  }


  // listInterfaces(), output example:
  // [
  //   {
  //     name: 'eth0',
  //     ip_address: '192.168.10.4',
  //     mac_address: '02:81:05:84:b0:5d',
  //     ip6_addresses: ['fe80::81:5ff:fe84:b05d'],
  //     ip6_masks: ['ffff:ffff:ffff:ffff::'],
  //     gateway_ip: '192.168.10.1',
  //     netmask: 'Mask:255.255.255.0',
  //     conn_type: 'Wired',
  //     gateway: '192.168.10.1',
  //     subnet: '192.168.10.0/24',
  //     gateway6: '',
  //     dns: ['192.168.10.1'],
  //     type: 'wan'
  //   },
  //   {
  //     name: 'eth0:0',
  //     ip_address: '192.168.218.1',
  //     mac_address: '02:81:05:84:b0:5d',
  //     netmask: 'Mask:255.255.255.0',
  //     conn_type: 'Wired',
  //     gateway: '192.168.218.1',
  //     gateway_ip: '192.168.218.1',
  //     subnet: '192.168.218.0/24',
  //     gateway6: '',
  //     dns: ['192.168.10.1'],
  //     type: 'lan'
  //   },
  // ]
  async listInterfaces() {
    let list = await linux.get_network_interfaces_list()
    if (list == null || list.length <= 0) {
      log.error('Discovery::Interfaces', 'No interfaces found');
      return [];
    }

    list = list.filter(this._is_interface_valid);

    list.forEach(i => {
      log.info('Found interface', i.name, i.ip_address);
      i.gateway = i.gateway_ip || null;
      i.subnet = this._getSubnet(i.name, i.ip_address, 'IPv4');
      i.gateway6 = linux.gateway_ip6_sync();
      i.dns = dns.getServers();
      i.rtid = 0; // just a placeholder on non-firerouter-managed platform
      if (i.ip_address) {
        i.ip4_addresses = [i.ip_address];
        if (i.subnet) {
          i.ip4_subnets = [i.subnet];
          i.ip4_masks = [ip.cidrSubnet(i.subnet).subnetMask];
        }
        if (i.gateway === null)
          i.type = "lan";
        else
          i.type = "wan";
      }
      i.searchDomains = [];

      // For wan interface, check user config to set whether alternative interface is in static or dhcp mode
      if (i.type == "wan") {
        if ("alternativeInterface" in fConfig) {
          i.assignment = "static"
        } else {
          i.assignment = "dhcp"
        }
      }
    });

    return list
  }

  capSubnet(cidrAddr) {
    if (!cidrAddr) {
      log.error("Invalid CIDR Address")
      return null
    }
    let subnetCap = platform.getSubnetCapacity();
    let subnet = ip.cidrSubnet(cidrAddr);
    if (subnet.subnetMaskLength < subnetCap) {
      log.info('Subnet capped to ' + subnet.networkAddress + '/' + subnetCap);
      return subnet.networkAddress + '/' + subnetCap;
    }
    else
      return cidrAddr;
  }
}

module.exports = function () {
  return new NetworkTool();
};
