/*    Copyright 2017 Firewalla LLC
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
const linux = require('../util/linux.js');
const ip = require('ip');
const os = require('os');
const dns = require('dns');
const network = require('network');
const log = require('./logger.js')(__filename, 'info');
const util = require('util');
const f = require('./Firewalla.js');
const fc = require('./config.js');
const { exec } = require('child-process-promise')

function is_interface_valid(netif) {
  return (
    netif.ip_address != null &&
    netif.mac_address != null &&
    netif.type != null &&
    !netif.ip_address.startsWith('169.254.')
  );
}

function getSubnets(networkInterface, family) {
  let networkInterfaces = os.networkInterfaces();
  let interfaceData = networkInterfaces[networkInterface];
  if (interfaceData == null) {
    return [];
  }

  var ipSubnets = [];

  for (let i = 0; i < interfaceData.length; i++) {
    if (
      interfaceData[i].family == family &&
      interfaceData[i].internal == false
    ) {
      let subnet = ip.subnet(
        interfaceData[i].address,
        interfaceData[i].netmask
      );
      ipSubnets.push(subnet);
    }
  }

  return ipSubnets;
}

exports.create = async function(config) {
  /*
  "secondaryInterface": {
     "intf":"eth0:0",
     "ip":"192.168.218.1/24",
     "ipsubnet":"192.168.218.0/24",
     "ipnet":"192.168.218",
     "ipmask":"255.255.255.0",
     "ip2":"192.168.168.1/24",
     "ipsubnet2":"192.168.168.0/24",
     "ipnet2":"192.168.168",
     "ipmask2":"255.255.255.0"
  },
  */
  const conf = config.secondaryInterface;
  if (!conf || !conf.intf) throw new Error("Invalid config");

  // ip can sufficiently identify a network configuration, all other configurations are redundant
  let secondaryIpSubnet = conf.ip;
  let secondarySubnet = ip.cidrSubnet(secondaryIpSubnet);
  let legacyIpSubnet = null;

  let list = await linux.get_network_interfaces_list_async()

  list = (list || []).filter(function(x) {
    return is_interface_valid(x);
  });

  const sameNameIntf = list.find(intf => intf.name == conf.intf)
  if (sameNameIntf) {
    if (
      sameNameIntf.netmask === 'Mask:' + secondarySubnet.subnetMask &&
      sameNameIntf.ip_address === secondaryIpSubnet.split('/')[0]
    ) {
      // same ip and subnet mask
      log.info('Already Created Secondary Interface', sameNameIntf);
      return { secondaryIpSubnet, legacyIpSubnet };
    } else {
      log.info('Update existing secondary interface: ' + conf.intf);
      // should be like 192.168.218.1
      const legacyCidrSubnet = ip.subnet(sameNameIntf.ip_address, sameNameIntf.netmask.substring(5));
      legacyIpSubnet = sameNameIntf.ip_address + "/" + legacyCidrSubnet.subnetMaskLength;
    }
  }

  for (const intf of list) {
    const subnets = getSubnets(intf.name, 'IPv4');

    const overlapped = subnets.find(net =>
      net.contains(secondarySubnet.firstAddress) ||
      net.contains(secondarySubnet.lastAddress) ||
      secondarySubnet.contains(net.firstAddress) ||
      secondarySubnet.contains(net.lastAddress)
    )

    log.warn('Overlapping network found!', overlapped)
    // one intf may have multiple ip addresses assigned
    if (overlapped) {
      // other intf already occupies ip1, use alternative ip
      secondaryIpSubnet = conf.ip2;
      let flippedConfig = {
        secondaryInterface: {
          intf: conf.intf,
          ip: conf.ip2,
          ip2: conf.ip
        }
      }
      fc.updateUserConfig(flippedConfig);

      break;
    }
  }

  // reach here if interface with specified name does not exist or its ip/subnet needs to be updated
  await exec(`sudo ifconfig ${conf.intf} ${secondaryIpSubnet}`)
  await exec(`sudo ${f.getFirewallaHome()}/scripts/config_secondary_interface.sh ${secondaryIpSubnet}`);

  return { secondaryIpSubnet, legacyIpSubnet };
};
