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
     "ip2":"192.168.168.1/24"
     "ipsubnet2":"192.168.218.0/24",
  },
*/
    if (config.secondaryInterface && config.secondaryInterface.intf) {
        let _secondaryIp = config.secondaryInterface.ip;
        let _secondaryIpSubnet = config.secondaryInterface.ipsubnet;
        linux.get_network_interfaces_list((err,list)=>{
            list = list.filter(function(x) { return is_interface_valid(x) });
            for (let i in list) {
                if (list[i].name == config.secondaryInterface.intf) {
                    log.error("SecondaryInterface: Already Created Secondary Interface",list[i]);
                    callback(null,_secondaryIp, _secondaryIpSubnet);
                    return; 
                }
                let subnet = getSubnet(list[i].name, 'IPv4');
                if (subnet == _secondaryIpSubnet) {
                    _secondaryIpSubnet = config.secondaryInterface.ipsubnet2;
                    _secondaryIp = config.secondaryInterface.ip2; 
                }
            }
            require('child_process').exec("sudo ifconfig "+config.secondaryInterface.intf+" "+_secondaryIp, (err, out, code) => { 
                if (err!=null) {
                    log.error("SecondaryInterface: Error Creating Secondary Interface",_secondaryIp,out);
                }
                if (callback) {
                    callback(err,_secondaryIp, _secondaryIpSubnet);
                }
            });
         });
    }
};
