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

  updateFilter() {
    let domainFilterFile = __dirname + "/filter.json";
    let dnsFilterFile = dnsFilterDir + "/filter.conf";

    let mkdirp = require('mkdirp');
    mkdirp(dnsFilterDir, function(err) {

      fs.unlinkSync(dnsFilterFile);

      let writer = fs.createWriteStream(dnsFilterFile);

      jsonfile.readFile(domainFilterFile, (err, obj) => {
        obj.forEach((hostname) => {
          let entry = util.format("address=/%s/198.51.100.99\n", hostname);
          writer.write(entry);
        });
        writer.end();
      });

    });


  }

  start(callback) {
    require('child_process').exec("sudo systemctl start dnsmasq", (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:START:Error", "Failed to start dnsmasq: " + err);
      }
      callback(err);
    });
  }

  stop(callback) {
    require('child_process').exec("sudo systemctl stop dnsmasq", (err, out, code) => {
      if(err) {
        log.error("DNSMASQ:STOP:Error", "Failed to stop dnsmasq: " + err);
      }
      callback(err);
    });
  }

  restart(callback) {
    this.stop((err) => {
      this.start(callback);
    })
  }

};
