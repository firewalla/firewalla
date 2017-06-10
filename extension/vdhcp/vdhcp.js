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
    log.info("VDHCPExtention:Install",install_cmd);
    require('child_process').exec(install_cmd, (err, out, code) => {
      if (err) {
        log.error("VDHCPDUMP:INSTALL:Error", "Failed to execute script install.sh", err);
      } else {
        log.info("VDHCPDUMP:INSTALL:Success", "DHCP Server is installed successfully");
      }

      callback(err, null);
    });
  }

  uninstall(callback) {
    // TODO
  }

  checkStatus(callback) {
  }

  start(force, local_net, local_mask, vdhcp_net, vdhcp_mask,  callback) {
    let cmdline = 'sudo '+__dirname+'/start.sh '+local_net+' '+ local_mask +' '+vdhcp_net+' '+vdhcp_mask;
    console.log("Starting VDHCPD Server with:", cmdline);
    let p = require('child_process').exec(cmdline, (err, stdout, stderr) => {
        if(err) {
          log.error("Failed to Start VDHCP: " + err);
        }
        callback(err);
    });
  }

  stop(callback) {
    let cmdline = 'sudo '+__dirname+'/stop.sh ';
    console.log("Stopping VDHCPD Server with:", cmdline);
    let p = require('child_process').exec(cmdline, (err, stdout, stderr) => {
        if(err) {
          log.error("Failed to Stop VDHCP: " + err);
        }
        callback(err);
    });
  }

  restart(callback) {
  }
};
