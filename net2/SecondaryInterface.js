/*    Copyright 2017-2021 Firewalla Inc.
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
const log = require('./logger.js')(__filename, 'info');
const f = require('./Firewalla.js');
const fc = require('./config.js');
const { exec } = require('child-process-promise')

function is_interface_valid(netif) {
  return (
    netif.ip_address != null &&
    netif.mac_address != null &&
    netif.conn_type != null &&
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
      const subnetMask = interfaceData[i].address + '/' + subnet.subnetMaskLength;
      ipSubnets.push(subnetMask);
    }
  }

  return ipSubnets;
}

function generateRandomIpSubnet(ipSubnet) {
  const max = 250, min = 11;
  const seg = Math.floor(Math.random() * (max - min + 1)) + min;//[11~250]
  const randomIpSubnet = "192.168." + seg + ".1/24";
  if (randomIpSubnet == ipSubnet) {
    return generateRandomIpSubnet(randomIpSubnet)
  } else {
    return randomIpSubnet;
  }
}

exports.create = async function (config) {
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
  let secondaryIpSubnet;
  const bootingComplete = await f.isBootingComplete();
  if (!bootingComplete) {
    //randomize overlay subnet when initial setup
    secondaryIpSubnet = generateRandomIpSubnet();
  } else {
    secondaryIpSubnet = conf.ip;
  }
  let secondarySubnet = ip.cidrSubnet(secondaryIpSubnet);
  let legacyIpSubnet = null;

  let list = await linux.get_network_interfaces_list()

  list = (list || []).filter(function (x) {
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

  const gatewayIp = await linux.gateway_ip_for(config.monitoringInterface)
  for (const intf of list) {
    const subnets = getSubnets(intf.name, 'IPv4');

    const overlapped = subnets.includes(secondaryIpSubnet);

    // one intf may have multiple ip addresses assigned
    if (overlapped) {
      // other intf already occupies ip1, use alternative ip
      log.warn('Overlapping network found!', secondaryIpSubnet);
      secondaryIpSubnet = generateRandomIpSubnet(secondaryIpSubnet);
      break;
    }
    if (secondaryIpSubnet.split('/')[0] === gatewayIp) {
      log.warn("Conflict with gateway IP: ", secondaryIpSubnet);
      secondaryIpSubnet = generateRandomIpSubnet(secondaryIpSubnet);
      break;
    }
  }

  let flippedConfig = {}
  flippedConfig.secondaryInterface = Object.assign({}, conf, {
    ip: secondaryIpSubnet
  })
  await fc.updateUserConfig(flippedConfig);

  // reach here if interface with specified name does not exist or its ip/subnet needs to be updated
  await exec(`sudo ifconfig ${conf.intf} ${secondaryIpSubnet}`)
  await exec(`sudo ${f.getFirewallaHome()}/scripts/config_secondary_interface.sh ${secondaryIpSubnet} ${conf.intf}`);

  return { secondaryIpSubnet, legacyIpSubnet };
};
