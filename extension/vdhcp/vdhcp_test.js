'use strict';
var SysManager = require('../../net2/SysManager.js');
var sysManager = new SysManager('info');
var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../../net2/config.json', 'utf8'));
let Vdhcp = require('./vdhcp.js');
let vdhcp = new Vdhcp();

var secondaryInterface = require("./../../net2/SecondaryInterface.js");
secondaryInterface.create(config,(err,ip,subnet,ipnet,mask)=>{
    if (err == null) {
        console.log("Successful Created Secondary Interface",ipnet,mask,ip,subnet);
        sysManager.secondaryIp = ip;
        sysManager.secondarySubnet = subnet; 
        sysManager.secondaryIpnet = ipnet; 
        sysManager.secondaryMask  = mask; 
        vdhcp.install((err)=>{
            if (err) {
                    console.log(err);
            } else {
                vdhcp.start(true,sysManager.mySubnetNoSlash(), sysManager.myIpMask(), sysManager.secondaryIpnet, sysManager.secondaryMask,(err)=>{
                    console.log(err);
                });
            } 
        });
    } else {
    }

});


