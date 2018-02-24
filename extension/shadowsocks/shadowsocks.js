/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

var instance = null;
var log = null;
var SysManager = require('../../net2/SysManager.js');
var sysManager = new SysManager('info');
let firewalla = require('../../net2/Firewalla.js');
//TODO: support real config file for Firewalla class
var key = require('../common/key.js');
var fHome = firewalla.getFirewallaHome();

var later = require('later');
var publicIp = require('public-ip');

var fs = require('fs');
var network = require('network');
var natpmp = require('nat-pmp');
var natupnp = require('nat-upnp');
var ip = require('ip');
var async = require('async');

var util = require('util');

var jsonfile = require('jsonfile');
var configFileLocation = fHome + '/etc/shadowsocks.config.json';

var ttlExpire = 60*60*12;

let externalPort = 8388;
let localPort = 8388;

let ssBinary = __dirname + "/bin." + firewalla.getPlatform() + "/fw_ss_server";
let ssLogFile = firewalla.getLogFolder() + "/fw_ss_server.log";

let cp = require('child_process')

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("shadowsocks manager", loglevel);

            instance = this;
        }
        return instance;
    }

    install(callback) {
      let install_cmd = util.format('cd %s/extension/shadowsocks; bash ./install.sh', fHome);
      cp.exec(install_cmd, (err, out, code) => {
            if (err) {
                log.error("ShadowSocks:INSTALL:Error", "Unable to install1.sh", err);
            }

            callback(err, null);
        });
    }

    configure(callback) {}

    stop(callback) {
      callback = callback || function() {}

      this.started = false;

      let UPNP = require('../../extension/upnp/upnp');
      let upnp = new UPNP("info", sysManager.myGateway());
      upnp.removePortMapping("tcp", localPort, externalPort);

      this._stop(callback);
    }

    _stop(callback) {
      callback = callback || function() {}

      let cmd = "pkill -9 fw_ss_server";
      cp.exec(cmd, (err, out, code) => {
        if(err) {
          log.debug("Failed to stop fw_ss_server", err, {});
          callback(err);
          return;
        }

        log.info("Shadowsocks is stopped");
        callback(err);
      });
    }

    start(callback) {
      callback = callback || function() {}

      // always stop first before start
      this._stop(() => {
        this._start(callback);
      })
    }

    _start(callback) {
      callback = callback || function() {}

      if (this.started) {
        log.info("Shadowsocks::StartedAlready");
        if (callback)
          callback(null, this.portmapped, this.portmapped);
        return;
      }

      log.info("Starting shadowsocks server...");

      let outputStream = fs.createWriteStream(ssLogFile, {flags: 'a'});

      let args = util.format("-c %s -v",
        configFileLocation
      );

      log.info("Running cmd:", ssBinary, args);

      let ss = cp.spawn(ssBinary, args.split(" "));

      ss.stdout.pipe(outputStream);
      ss.stderr.pipe(outputStream);

      ss.on('exit', (code) => {
        if(code) {
          log.error("Shadowsocks server exited with error code", code);
        } else {
          log.info("Shadowsocks server exited successfully");
        }
      });

      this.started = true;

      this.addPortMapping(1000);
    }

  addPortMapping(time) {
    log.debug("addPortMapping is called");
    if(!this.started) {
        return;
    }

    setTimeout(() => {
      let UPNP = require('../../extension/upnp/upnp');
      let upnp = new UPNP("info", sysManager.myGateway());
      upnp.addPortMapping("tcp", localPort, externalPort, "Shadowsocks Proxy Port", (err) => {
        if(err) {
          log.error("Failed to add port mapping for Shadowsocks Proxy Port: " + err);
        } else {
          log.debug("Portmapping is successfully created for Shadowsocks Proxy Port");
        }
      });
      this.addPortMapping(3600 * 1000); // add port every hour
    }, time)
  }

    getConfigFileLocation() {
        return configFileLocation;
    }

    setConfigFileLocation(location) {
        configFileLocation = location;
    }

    readConfig() {
        try {
          let config = jsonfile.readFileSync(configFileLocation);
          return config;
        } catch (err) {
          return null;
        }
    }

    configExists() {
        return this.readConfig() !== null;
    }

    refreshConfig(password) {
        if(password == null) {
            password = key.randomPassword(8);
        }
        let config = JSON.parse(fs.readFileSync(fHome + '/extension/shadowsocks/ss.config.json.template', 'utf8'));
        // not necessary to specify local ip address in shadowsocks configuration
        // config.server = sysManager.myIp();
        config.password = password
        jsonfile.writeFileSync(configFileLocation, config, {spaces: 2})
    }

    generateEncodedURI(ssConfig, publicServerName) {
        let uri = util.format("%s:%s@%s:%d",ssConfig.method, ssConfig.password, publicServerName, ssConfig.server_port);
        log.debug("uri is: " + uri);
        let encodedURI = new Buffer(uri).toString('base64');
        log.debug("encoded uri is: " + encodedURI);

        return encodedURI
    }

    generateQRCode(encodedURI) {
        var qrcode = require('qrcode-terminal');
        qrcode.generate("ss://" + encodedURI);
    }
}
