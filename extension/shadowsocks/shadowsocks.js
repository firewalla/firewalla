/*    Copyright 2016-2022 Firewalla Inc.
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
const log = require("../../net2/logger.js")(__filename);

const UPNP = require('../../extension/upnp/upnp');
const upnp = new UPNP();
const firewalla = require('../../net2/Firewalla.js');
//TODO: support real config file for Firewalla class
const key = require('../common/key.js');
const fHome = firewalla.getFirewallaHome();

const util = require('util');

const jsonfile = require('jsonfile');
const jsReadFile = util.promisify(jsonfile.readFile)
const jsWriteFile = util.promisify(jsonfile.writeFile)
const fs = require('fs')
const configFileLocation = fHome + '/etc/shadowsocks.config.json';

const externalPort = 8388;
const localPort = 8388;

const ssBinary = __dirname + "/bin." + firewalla.getPlatform() + "/fw_ss_server";
const ssLogFile = firewalla.getLogFolder() + "/fw_ss_server.log";

const cp = require('child_process')

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
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

      upnp.removePortMapping("tcp", localPort, externalPort);

      this._stop(callback);
    }

    _stop(callback) {
      callback = callback || function() {}

      let cmd = "pkill -9 fw_ss_server";
      cp.exec(cmd, (err, out, code) => {
        if(err) {
          log.debug("Failed to stop fw_ss_server", err);
          callback();
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

    async readConfig() {
        try {
          let config = await jsReadFile(configFileLocation);
          return config;
        } catch (err) {
          return null;
        }
    }

    async configExists() {
        return await this.readConfig() !== null;
    }

    async refreshConfig(password) {
        if(password == null) {
            password = key.randomPassword(8);
        }
        let config = await jsReadFile(fHome + '/extension/shadowsocks/ss.config.json.template', 'utf8')
        // not necessary to specify local ip address in shadowsocks configuration
        // config.server = sysManager.myIp();
        config.password = password
        await jsWriteFile(configFileLocation, config, {spaces: 2})
    }

    generateEncodedURI(ssConfig, publicServerName) {
        let uri = util.format("%s:%s@%s:%d",ssConfig.method, ssConfig.password, publicServerName, ssConfig.server_port);
        let encodedURI = Buffer.from(uri).toString('base64');
        log.debug("encoded uri is: " + encodedURI);

        return encodedURI
    }

    generateQRCode(encodedURI) {
        var qrcode = require('qrcode-terminal');
        qrcode.generate("ss://" + encodedURI);
    }
}
