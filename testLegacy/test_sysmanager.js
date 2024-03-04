'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect,
    exec  = require('child_process').exec;
var sysManager = require('../net2/SysManager.js');
var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/config.json', 'utf8'));
sysManager.setConfig(config);

function trim_exec(cmd, cb) {
  exec(cmd, function(err, out) {
    if (out && out.toString() != '')
      cb(null, out.toString().trim())
    else
      cb(err)
  })
}

setTimeout(function() {
    expect(sysManager.isSystemDebugOn()).to.be.false;
    sysManager.debugOn().then(() => {
        expect(sysManager.isSystemDebugOn()).to.be.true;
        sysManager.debugOff().then(() => {
            expect(sysManager.isSystemDebugOn()).to.be.false;
        });
    });
    let ip_cmd = "/sbin/ifconfig | grep -Eo 'inet (addr:)?([0-9]*\\.){3}[0-9]*' | grep -Eo '([0-9]*\\.){3}[0-9]*' | grep -v '127.0.0.1' | grep -v '10.8.0'"
    trim_exec(ip_cmd, function(err,output) { 
        expect(output).to.equal(sysManager.myIp());   

        let dns_cmd = "cat /etc/resolv.conf | grep nameserver | awk '{print $2}' | head -n 1"
        trim_exec(dns_cmd, function(err2, output2) {
            expect(output2).to.equal(sysManager.myDNS()[0]);

            setTimeout(function() {
                console.log("Pass!");
                process.exit();
            },3000);
        });
    } );
},1000);

