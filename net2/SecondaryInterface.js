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
var linux = require('../util/linux.js');
var ip = require('ip');
var os = require('os');
var dns = require('dns');
var network = require('network');
var log = require("./logger.js")(__filename, "info");

function  is_interface_valid(netif) {
     return netif.ip_address != null && netif.mac_address != null && netif.type != null && !netif.ip_address.startsWith("169.254.");
}

function    getSubnet(networkInterface, family) {
        let networkInterfaces = os.networkInterfaces();
        let interfaceData = networkInterfaces[networkInterface];
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

exports.create = function (config, callback) {
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
    if (config.secondaryInterface && config.secondaryInterface.intf) {
        let _secondaryIp = config.secondaryInterface.ip;
        let _secondaryIpSubnet = config.secondaryInterface.ipsubnet;
        let _secondaryIpNet = config.secondaryInterface.ipnet;
        let _secondaryMask = config.secondaryInterface.ipmask;
        let legacyIp = null;
        let legacySubnet = null;
        linux.get_network_interfaces_list((err,list)=>{
            list = list.filter(function(x) { return is_interface_valid(x) });
            for (let i in list) {
                if (list[i].name == config.secondaryInterface.intf) {
                    if (list[i].netmask === "Mask:" + _secondaryMask && list[i].ip_address === _secondaryIp.split('/')[0]) {
                        // same ip and subnet mask
                        log.info("Already Created Secondary Interface",list[i]);
                        callback(null,_secondaryIp, _secondaryIpSubnet,_secondaryIpNet, _secondaryMask, legacyIp, legacySubnet);
                        return;
                    } else {
                        log.info("Update existing secondary interface: " + config.secondaryInterface.intf);
                        const legacyIpSubnet = ip.subnet(list[i].ip_address, list[i].netmask.substring(5));
                        legacyIp = legacyIpSubnet.firstAddress + "/" + legacyIpSubnet.subnetMaskLength; // should be like 192.168.218.1/24
                        legacySubnet = legacyIpSubnet.networkAddress + "/" + legacyIpSubnet.subnetMaskLength; // should be like 192.168.218.0/24
                    }
                } else {
                    // other interface already occupies ip1, use alternative ip
                    let subnet = getSubnet(list[i].name, 'IPv4');
                    if (subnet == _secondaryIpSubnet) {
                        _secondaryIpSubnet = config.secondaryInterface.ipsubnet2;
                        _secondaryIp = config.secondaryInterface.ip2;
                        _secondaryIpNet = config.secondaryInterface.ipnet2;
                        _secondaryMask = config.secondaryInterface.ipmask2;
                    }
                }
            }
            // reach here if interface with specified name does not exist or its ip/subnet needs to be updated
            require('child_process').exec("sudo ifconfig "+config.secondaryInterface.intf+" "+_secondaryIp, (err, out, code) => {
                if (err!=null) {
                    log.error("SecondaryInterface: Error Creating Secondary Interface",_secondaryIp,out);
                }
                require('child_process').exec("sudo /home/pi/firewalla/scripts/config_secondary_interface.sh "+_secondaryIp,(err,out,code)=>{
                });
                if (callback) {
                    callback(err,_secondaryIp, _secondaryIpSubnet, _secondaryIpNet, _secondaryMask, legacyIp, legacySubnet);
                }
            });
         });
    }
};
