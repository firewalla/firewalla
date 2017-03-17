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
  
  rawStart(callback) {
    callback = callback || function() {}

    let spawn = require('child_process').spawn;
    let dhcpdumpSpawn = spawn('sudo', ['dhcpdump', '-i', 'eth0']);
    let pid = dhcpdumpSpawn.pid;

    log.info("DHCPDump started with PID: ", pid); 

    dhcpdumpSpawn.stdout.on('data', (data) => {
      log.info(data);
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
    // 0. update resolv.conf
    // 1. update filter
    // 2. start dnsmasq service
    // 3. update iptables rule

    this.updateResolvConf((err) => {
      if(err) {
        callback(err);
        return;
      }
      
      this.updateFilter(force, (err) => {
        if(err) {
          callback(err);
          return;
        }

        this.rawStop((err) => {
          this.rawStart((err) => {
            if(err) {
              this.rawStop();
              callback(err);
              return;
            }
            
            this.add_iptables_rules((err) => {
              if(err) {
                this.rawStop();
                this.remove_iptables_rules();
              }
              callback(err);
            });
          });
        });
                     
      });
      
    });
  }

  stop(callback) {
    // 1. remove iptables rules
    // 2. stop service
    // optional to remove filter file

    this.remove_iptables_rules((err) => {
      this.rawStop((err) => {
        callback(err);
        }
      );
    })
  }

  restart(callback) {
    require('child_process').exec("sudo systemctl restart dnsmasq", (err, out, code) => {
      if(err) {
        log.error("DHCPDUMP:RESTART:Error", "Failed to restart dnsmasq: " + err);
      }
      callback(err);
    });
  }

};
