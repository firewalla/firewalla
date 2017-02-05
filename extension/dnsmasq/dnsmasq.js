/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');
let key = require('../common/key.js');
let jsonfile = require('jsonfile');

let Firewalla = require('../../net2/Firewalla.js');
let f = new Firewalla("config.json", 'info');
let fHome = f.getFirewallaHome();
let dnsFilterDir = f.getUserHome() + "/.dns";


module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      log = require("../../net2/logger.js")("dnsmasq", loglevel);

      instance = this;
    }
    return instance;
  }

  install(callback) {
    let install_cmd = util.format('cd %s; bash ./install.sh', __dirname);
    require('child_process').exec(install_cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:INSTALL:Error", "Failed to execute script install.sh", err);
      }

      callback(err, null);
    });
  }

  uninstall(callback) {

  }

  readFilter(callback)  {
    let domainFilterFile = __dirname + "/filter.json";
    jsonfile.readFile(domainFilterFile, callback);
  }

  updateFilter(callback) {
    let domainFilterFile = __dirname + "/filter.json";
    let dnsFilterFile = dnsFilterDir + "/filter.conf";

    let updateFilter = function() {
      let writer = fs.createWriteStream(dnsFilterFile);

      jsonfile.readFile(domainFilterFile, (err, obj) => {
        obj.forEach((hostname) => {
          let entry = util.format("address=/%s/198.51.100.99\n", hostname);
          writer.write(entry);
        });
        writer.end();
      });
    };

    let mkdirp = require('mkdirp');
    mkdirp(dnsFilterDir, function(err) {

      fs.stat(dnsFilterFile, (err, stats) => {
        if (!err) {
          fs.unlink(dnsFilterFile, (err) => {
            updateFilter();
          });
        } else {
          updateFilter();
        }
      });
    });


  }

  start(callback) {
    require('child_process').exec("sudo systemctl start dnsmasq", (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:START:Error", "Failed to start dnsmasq: " + err);
        callback(err);
      } else {

        // Use iptables to redirect all dns traffic to pi itself
        let SysManager = require('../../net2/SysManager');
        let sysManager = new SysManager();
        let piIP = sysManager.myIp();
        let gatewayIP = sysManager.myGateway();

        let iptables_rule = util.format("sudo iptables -t nat -A PREROUTING -p udp --dport 53 --destination %s -j DNAT --to-destination %s:53", gatewayIP, piIP);
        require('child_process').exec(iptables_rule, (err, out, code) => {
          if(err) {
            log.error("DNSMASQ:START:Error", "Failed to add iptables rule for dnsmasq: " + err);
            callback(err);
          } else {
            callback();
          }
        });
      }
    });
  }

  stop(callback) {
    let SysManager = require('../../net2/SysManager');
    let sysManager = new SysManager();
    let piIP = sysManager.myIp();
    let gatewayIP = sysManager.myGateway();

    let iptablesRemoveRule = util.format("sudo iptables -t nat -D PREROUTING -p udp --dport 53 --destination %s -j DNAT --to-destination %s:53", gatewayIP, piIP);

    require('child_process').exec(iptablesRemoveRule, (err, out, stderr) => {
      if(err && stderr.indexOf("No chain/target/match by that name") === -1) { // not contain this substring
        log.error("DNSMASQ:STOP:Error", "Failed to remove iptables rule for dnsmasq: " + err);
        callback(err);
      } else {
        require('child_process').exec("sudo systemctl stop dnsmasq", (err, out, code) => {
          if(err) {
            log.error("DNSMASQ:STOP:Error", "Failed to stop dnsmasq: " + err);
          }
          callback(err);
        });
      }
    });
  }

  restart(callback) {
    require('child_process').exec("sudo systemctl restart dnsmasq", (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:RESTART:Error", "Failed to restart dnsmasq: " + err);
      }
      callback(err);
    });
  }

};
