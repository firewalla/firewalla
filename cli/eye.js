#!/usr/bin/env node

/*
 * Features
 *  - get host list
 *  - get host information
 *  
 */

'use strict'
var fs = require('fs');
var program = require('commander');

var HostManager = require("../net2/HostManager.js");
var hostManager = new HostManager();

program.version('0.0.2')
    .option('--host [host]', 'configuration')
    .option('--flows', '(optional) name')
    .option('--notice ', '(optional) endpoint')

program.parse(process.argv);
let ip = null;

if (program.host == null) {
    hostManager.getHosts((err, result) => {
        console.log(result);
    });
} else {
    ip = program.host;

    hostManager.getHost(ip, (err, result) => {
        console.log(result);
        result.packageTopNeighbors(60,(err,neighborArray)=>{
            // by count
            console.log("==== by count ====");
            console.log(neighborArray);
            console.log("==== by date ====");
            if (neighborArray == null) { 
                console.log("Found Nothing");
                return;
            }
            neighborArray.sort(function (a, b) {
                return Number(b.ts) - Number(a.ts);
            });
            console.log(neighborArray);

            console.log("==== by duration ====");
            neighborArray.sort(function (a, b) {
                return Number(b.du) - Number(a.du);
            });
            console.log(neighborArray);
        });
    });
}
