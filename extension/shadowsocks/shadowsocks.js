/*    Copyright 2016 Rottiesoft LLC 
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
var Firewalla = require('../../net2/Firewalla.js');
//TODO: support real config file for Firewalla class
var firewalla = new Firewalla('/path/to/config', 'info');
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
      require('child_process').exec(install_cmd, (err, out, code) => {
            if (err) {
                log.error("ShadowSocks:INSTALL:Error", "Unable to install1.sh", err);
            }

            callback(err, null);
        });
    }

    configure(callback) {}

    stop(callback) {
        this.started = false;

        let UPNP = require('../extension/upnp/upnp');
        let upnp = new UPNP();
        upnp.removePortMapping("tcp", localPort, externalPort);

        let cmd = require('util').format("ssserver -d stop --pid %s/run/ss.pid", fHome);
        require('child_process').exec(cmd, (err, out, code) => {
            log.info("Stopping ShadowSocket", err);
            if (callback) {
                callback(err);
            }
        });
    }

    start(callback) {
        if (this.started) {
            log.info("Shadowsocks::StartedAlready");
            if (callback)
                 callback(null, this.portmapped, this.portmapped);
            return;
        }

        let cmd = require('util').format("ssserver -d start -c %s --pid-file %s/run/ss.pid --log-file %s/log/ss.log", configFileLocation, fHome, fHome);
        log.info(cmd);
        require('child_process').exec(cmd, (err, out, code) => {
            log.info("Shadowsocks:Start", err);
            if (err && this.started == false) {
                if (callback) {
                    callback(err);
                }
                return;
            }
            this.started = true;

            let UPNP = require('../extension/upnp/upnp');
            let upnp = new UPNP();
            upnp.addPortMapping("tcp", localPort, externalPort, "shadowsocks", callback);
        });
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
        config.server = sysManager.myIp();
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
