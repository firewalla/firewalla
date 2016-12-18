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
var seed = 11;

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("shadowsocks manager", loglevel);

            instance = this;
        }
        return instance;
    }

    punchNat(opts, success, error) {
        opts = opts || {}
        opts.timeout = opts.timeout || 5000

        log.info("Shadowsocks:PunchNat",opts);
      
        let replied = false;
        // returns the IP of the gateway that your active network interface is linked to
        network.get_gateway_ip((err, gateway) => {
            if (err) return error(err)
            if (ip.isPublic(gateway))
                return success(gateway)

            if (this.upnpClient == null) {
                this.upnpClient = natupnp.createClient();
            }
            this.upnpClient.portMapping(opts, (err) => {
                if (err == null) {
                    log.info("Shadowsocks:NatUPNP Success");
                    if (replied == false) {
                        replied = true;
                        success(null, "success", null);
                    }
                } else {
                    if (replied == false) {
                        log.error("Shadowsocks:NatUPNP failed",err);
                        replied = true;
                        error(err);
                    }
                }

                // Just add protection code to avoid crash upnpClient is null
                if (this.upnpClient != null) {
                    this.upnpClient.close();
                    this.upnpClient = null;
                }
            });
        });
    }

    unpunchNat(opts, callback) {
        log.info("Shadowsocks:UnpunchNat", opts);
        if (this.upnpClient == null) {
            this.upnpClient = natupnp.createClient();
        }
        this.upnpClient.portUnmapping(opts,(err)=>{
            this.upnpClient.close();
            this.upnpClient = null;
            this.portmapped = false;
            if (callback) {
                callback(err);
            }
        });
    }

    install(callback) {
	let install_cmd = util.format('cd %s/extension/shadowsocks; bash ./install.sh', fHome);
        this.install = require('child_process').exec(install_cmd, (err, out, code) => {
            if (err) {
                log.error("ShadowSocks:INSTALL:Error", "Unable to install1.sh", err);
            }

            callback(err, null);
        });
    }

    configure(callback) {}

    stop(callback) {
        this.started = false;
        this.unpunchNat({
            protocol: 'tcp',
            private: 8388,
            public: 8388
        });
        let cmd = require('util').format("ssserver -d stop --pid %s/run/ss.pid", fHome);
        require('child_process').exec(cmd, (err, out, code) => {
            log.info("Stopping ShadowSocket", err);
            if (callback) {
                callback(err);
            }
        });
    }

    setNat(callback) {
        if (this.started == false) {
            if (callback)
                callback(null, null, null);
            return;
        }
        this.punchNat({
            type: 'tcp',
            protocol: 'tcp',
            private: 8388,
            public: 8388,
            ttl: 0,
            description: "Firewalla Shadowsocks"
        }, (external) => {
            log.info("Shadowsocks:Start:portMap", external);
            setTimeout(() => {
                log.info("Shadowsocks:Restart:portMap");
                this.setNat(null)
            }, ttlExpire/3*1000);
            if (callback) {
                this.portmapped = true;
                callback(null, external, 8388);
            }
        }, (err) => {
            log.info("Shadowsocks:Start:portMap:Failed: " + err);
            setTimeout(() => {
                log.info("Shadowsocks:Restart:portMap");
                this.setNat(null)
            }, ttlExpire/3*1000);
            if (callback) {
                callback(null, null, null);
            }
        })
    }

    start(callback) {
        if (this.started) {
            log.info("Shadowsocks::StartedAlready");
            if (callback)
                 callback(null, this.portmapped, this.portmapped);
            return;
        }
        this.unpunchNat({
            protocol: 'tcp',
            private: 8388,
            public: 8388
        },(err)=>{
            let cmd = require('util').format("ssserver -d start -c %s --pid-file %s/run/ss.pid --log-file %s/log/ss.log", configFileLocation, fHome, fHome);
            console.log(cmd);
            require('child_process').exec(cmd, (err, out, code) => {
                log.info("Shadowsocks:Start", err);
                if (err && this.started == false) {
                    if (callback) {
                        callback(err);
                    }
                    return;
                }
                this.started = true;
                this.setNat(callback);
            });
        });
    }

    function random() {
        var x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }

    generatePassword(len) {
        var length = len,
            charset = "0123456789abcdefghijklmnopqrstuvwxyz",
            retVal = "";
        for (var i = 0, n = charset.length; i < length; ++i) {
            retVal += charset.charAt(Math.floor(random() * n));
        }
        return retVal;
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
            password = this.generatePassword(8);
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
