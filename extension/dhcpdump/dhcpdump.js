/**
 * Created by Melvin Tu on 14/03/2017.
 * To capture DHCP events
 */

'use strict';

let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');
let jsonfile = require('jsonfile');

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let userID = f.getUserID();
let dhcpdumpSpawn = null;
let pid = null;

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      log = require("../../net2/logger.js")(__filename, loglevel);
      instance = this;
    }
    return instance;
  }

  install(callback) {
    callback = callback || function() {}

    let install_cmd = util.format('cd %s; bash ./install.sh', __dirname);
    log.info("DHCPExtention:Install",install_cmd);
    require('child_process').exec(install_cmd, (err, out, code) => {
      if (err) {
        log.error("DHCPDUMP:INSTALL:Error", "Failed to execute script install.sh", err);
      } else {
        log.info("DHCPDUMP:INSTALL:Success", "DHCPDump is installed successfully");
      }

      callback(err, null);
    });
  }

  uninstall(callback) {
    // TODO
  }

  checkStatus(callback) {
    callback = callback || function() {}

    let cmd = util.format("ps aux | grep %s | grep -v grep", dnsmasqBinary);
    log.info("Command to check dnsmasq: ", cmd);
    
    require('child_process').exec(cmd, (err, stdout, stderr) => {
      if(stdout !== "") {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  processData(data, callback) {
    callback = callback || function() {}
    
  }

/*
OPTION:  57 (  2) Maximum DHCP message size 1500
OPTION:  61 (  7) Client-identifier         01:c8:69:cd:09:95:4c
OPTION:  50 (  4) Request IP address        192.168.2.232
OPTION:  51 (  4) IP address leasetime      7776000 (12w6d)
OPTION:  12 ( 12) Host name                 Great-Room-3
*/
  parseOptions2(output,options) {
     var i = 0;
     let eol = require('os').EOL;
     while (i < output.length)
     {
        var j = output.indexOf('\r', i+1);
        if (j == -1) j = output.length;
        let str = output.substr(i,j-1);
        console.log("line: ",str);
        i = j+1;
     } 
  }
 
  parse(output) {
     console.log("DHCPDUMP Parsing output:",output);
     let o =  output.split(/\r?\n/);
     let obj = {};
     for (let i in o) {
         let options = o[i].split(' ');
         if (options[0].indexOf("OPTION:")==-1) {
             continue;
         }
         if (o[i].indexOf("Host name")>-1) {
             obj.name = options[options.length-1];
             obj.nname = options[options.length-1];
         }
         if (o[i].indexOf("Client-identifier")>-1) {
             obj.mac = options[options.length-1];
             obj.mac = obj.mac.toUpperCase();
             if (obj.mac.length==20) {
                obj.mac = obj.mac.substr(3,19);
             }
             if (obj.mac.length!=17) {
                 return {};
             }
         }
         if (o[i].indexOf("Request IP address")>-1) {
             obj.ipv4Addr = options[options.length-1];
             obj.uid = options[options.length-1];
             if (obj.uid.length<7) {
                 return {};
             }
         }
     }
     return obj; 
  }

  rawStart(callback) {
    callback = callback || function() {}


    let spawn = require('child_process').spawn;
    let dhcpdumpSpawn = spawn('sudo', ['dhcpdump', '-i', 'eth0']);
    let pid = dhcpdumpSpawn.pid;
    let StringDecoder = require('string_decoder').StringDecoder;
    let  decoder = new StringDecoder('utf8');

    log.info("DHCPDump started with PID: ", pid); 

    dhcpdumpSpawn.stdout.on('data', (data) => {
         var message = decoder.write(data);
         let obj = this.parse(message); 
         if (obj && obj.uid && obj.mac) {
             callback(obj); 
         }
    });

    dhcpdumpSpawn.stderr.on('data', (data) => {
      log.error("Got error when running dhcp: ", data);
    });

    dhcpdumpSpawn.on('close', (code) => {
      log.info("DHCPDump exited with error code: ", code);
    });
  }

  rawStop(callback) {
    callback = callback || function() {}

    //to be safe, kill all dhcpdumps
    require('child_process').exec("sudo pkill dhcpdump", (errorCode, stdout, stderr) => {
    });    
  }

  start(force, callback) {
    let cmdline = 'sudo pkill -f dhcpdump';
    let p = require('child_process').exec(cmdline, (err, stdout, stderr) => {
        if(err) {
          log.error("Failed to clean up spoofing army: " + err);
        }
        this.rawStart(callback);
    });
  }

  stop(callback) {
  }

  restart(callback) {
  }

};
