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

let SysManager = require('../../net2/SysManager');
let sysManager = new SysManager();


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
      } else {
        log.info("DNSMASQ:INSTALL:Success", "Dnsmasq is installed successfully");
      }

      callback(err, null);
    });
  }

  uninstall(callback) {

  }

  readFilter(callback)  {
    let domainFilterFile = __dirname + "/.temp.json";
    jsonfile.readFile(domainFilterFile, callback);
  }

  add_iptables_rules(callback) {
    let gatewayIP = sysManager.myGateway();
    let localIP = sysManager.myIp();

    let rule = util.format("GATEWAY_IP=%s LOCAL_IP=%s bash %s", gatewayIP, localIP, require('path').resolve(__dirname, "add_iptables.template.sh"));
    log.debug("Command to add iptables rules: ", rule);

    require('child_process').exec(rule, (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:IPTABLES:Error", "Failed to add iptables rules: " + err);
        callback(err);
      } else {
        log.info("DNSMASQ:IPTABLES", "Iptables rules are added successfully");
        callback();
      }
    });
  }


  remove_iptables_rules(callback) {
    let gatewayIP = sysManager.myGateway();
    let localIP = sysManager.myIp();

    let rule = util.format("GATEWAY_IP=%s LOCAL_IP=%s bash %s", gatewayIP, localIP, require('path').resolve(__dirname, "remove_iptables.template.sh"));

    require('child_process').exec(rule, (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:IPTABLES:Error", "Failed to remove iptables rules: " + err);
        callback(err);
      } else {
        log.info("DNSMASQ:IPTABLES", "Iptables rules are removed successfully");
        callback();
      }
    });
  }

  updateFilter(callback) {
    let domainFilterFile = __dirname + "/filter.json";
    let dnsFilterFile = dnsFilterDir + "/filter.conf";

    let updateFilterX = function() {
      let writer = fs.createWriteStream(dnsFilterFile);

      jsonfile.readFile(domainFilterFile, (err, obj) => {
        if(err) {
          callback(err);
          return;
        }
        obj.basic.forEach((hostname) => { // FIXME: Support multiple cateogires in filter json file
          let entry = util.format("address=/%s/198.51.100.99\n", hostname);
          writer.write(entry);
        });
        writer.end();
      });
    };

    let mkdirp = require('mkdirp');
    mkdirp(dnsFilterDir, function(err) {

      if(err) {
        callback(err);
        return;
      }

      fs.stat(dnsFilterFile, (err, stats) => {
        if (!err) {
          fs.unlink(dnsFilterFile, (err) => {
            updateFilterX();
            callback(err);
          });
        } else {
          updateFilterX();
          callback(err);
        }
      });
    });


  }

  rawStart(callback) {
    callback = callback || function() {}

    // use restart to ensure the latest configuration is loaded
    let cmd = "sudo systemctl restart dnsmasq";

    if(require('fs').existsSync("/.dockerenv")) {
      cmd = "sudo service dnsmasq restart";
    }

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to start dnsmasq: " + err);
      }

      callback(err);
    })
  }

  rawStop(callback) {
    callback = callback || function() {}

    let cmd = "sudo systemctl stop dnsmasq";

    if(require('fs').existsSync("/.dockerenv")) {
      cmd = "sudo service dnsmasq stop";
    }

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to stop dnsmasq: " + err);
      }

      callback(err);
    })
  }

  rawRestart(callback) {
    callback = callback || function() {}

    let cmd = "sudo systemctl restart dnsmasq";

    if(require('fs').existsSync("/.dockerenv")) {
      cmd = "sudo service dnsmasq restart";
    }

    require('child_process').exec(cmd, (err, out, code) => {
      if (err) {
        log.error("DNSMASQ:START:Error", "Failed to restart dnsmasq: " + err);
      }

      callback(err);
    })
  }

  start(callback) {
    // 1. update filter
    // 2. start dnsmasq service
    // 3. update iptables rule

    this.updateFilter((err) => {
      if(err) {
        callback(err);
        return;
      }

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
        })
      })
    })
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
        log.error("DNSMASQ:RESTART:Error", "Failed to restart dnsmasq: " + err);
      }
      callback(err);
    });
  }

};
