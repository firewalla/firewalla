'use strict';

var chai = require('chai');
var expect = chai.expect;

var sysManager= require('../net2/SysManager.js');
var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/config.json', 'utf8'));
sysManager.setConfig(config);

setTimeout(function() {
    var VPN = require('../vpn/VpnManager.js');
    var vpn = new VPN('info');

    vpn.getOvpnFile("test1", "123456", true, function(err, ovpn, password) {
        console.log(err);
        console.log(ovpn);
        console.log(password);
        vpn.start(function(err) {
            if(err) {
                console.log(err);
/*
                vpn.stop(function(err) {
                    if(err) {
                        console.log(err);
                        process.exit(0);
                    }
                });
*/
            }
        });
    });
},3000);

