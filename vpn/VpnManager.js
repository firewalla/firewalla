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
var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');

var redis = require("redis");
var rclient = redis.createClient();

var later = require('later');
var publicIp = require('public-ip');

var fs = require('fs');
var network = require('network');
var natpmp = require('nat-pmp');
var natupnp = require('nat-upnp');
var ip = require('ip');
var async = require('async');


module.exports = class {
    constructor(path, loglevel) {
        if (instance == null) {
            log = require("../net2/logger.js")("vpn manager", loglevel);

            instance = this;
        }
        return instance;
    }

    punchNat(opts, success, error) {
        opts = opts || {}
        opts.timeout = opts.timeout || 5000

        log.info("VpnManager:PunchNat",opts);
      
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
                    log.info("VpnManager:NatUPNP Success");
                    if (replied == false) {
                        replied = true;
                        success(null, "success", null);
                    }
                } else {
                    if (replied == false) {
                        log.error("VpnManager:NatUPNP failed",err);
                        replied = true;
                        error(err);
                    }
                }
            });
        });
    }

    unpunchNat(opts) {
        if (this.upnpClient == null) {
            return;
        }
        this.upnpClient.portUnmapping(opts);
        log.info("VpnManager:UnpunchNat", opts);
    }

    setupNat2(opts, success, error) {
        opts = opts || {}
        opts.timeout = opts.timeout || 5000

        // returns the IP of the gateway that your active network interface is linked to
        network.get_gateway_ip((err, gateway) => {
            if (err) return error(err)

            // use regex to check if ip address is public
            if (ip.isPublic(gateway))
                return success(gateway)

            var strategies = {
                //          pmp: natpmp.connect(gateway),
                upnp: natupnp.createClient()
            };

            // find a strategy to traverse nat
            try {
                async.detectSeries(strategies, (client, next) => {
                    let portMapping = async.timeout(client.portMapping.bind(client), opts.timeout)
                    portMapping(opts, (err) => {
                        next(null, !err)
                    });
                }, (err, client) => {
                    if (err) return error(err)

                    log.info("VpnManager:SetupNat:Success");
                    if (!client) return error(new Error('All NAT strategies failed or timed out'))
                    log.info("VpnManager:SetupNat:Success2");

                    client.externalIp((err, external) => {
                        if (err) return error(err)
                        success(external)
                    })
                })
            } catch (e) {}
        })
    }

    install(callback) {
        this.install1 = require('child_process').exec("cd /home/pi/firewalla/vpn; sudo ./install1.sh", (err, out, code) => {
            if (err) {
                log.error("VPNManager:INSTALL:Error", "Unable to install1.sh", err);
            }
            if (err == null) {
                publicIp.v4((err, ip) => {
                    if (err != null) {
                        if (callback) 
                            callback(err, null);
                        return;
                    }
                    let cmd = "sudo ./install2.sh " + sysManager.myIp() + " " + ip;
                    log.info("VPNManager:INSTALL:cmd", cmd);
                    this.install2 = require('child_process').exec("cd /home/pi/firewalla/vpn; " + cmd, (err, out, code) => {
                        if (err) {
                            log.error("VPNManager:INSTALL:Error", "Unable to install2.sh", err);
                        }
                        log.info("VPNManager:INSTALL:Done");
                        if (callback) {
                            callback(err, null);
                        }
                    });
                });
            } else {
                if (callback) 
                    callback(err, null);
            }
        });
    }

    configure(callback) {}

    stop(callback) {
        this.started = false;
        this.unpunchNat({
            protocol: 'udp',
            private: 1194,
            public: 1194
        });
        require('child_process').exec("sudo service openvpn stop", (err, out, code) => {
            log.info("Stopping OpenVpn", err);
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
            type: 'udp',
            protocol: 'udp',
            private: 1194,
            public: 1194,
            ttl: 7200,
            timeout: 7200
        }, (external) => {
            log.info("VpnManager:Start:portMap", external);
            setInterval(() => {
                this.setNat(null)
            }, 7210*1000);
            if (callback) {
                this.portmapped = true;
                callback(null, external, 1194);
            }
        }, (err) => {
            log.info("VpnManager:Start:portMap:Failed");
            if (callback) {
                callback(null, null, null);
            }
        })
    }

    start(callback) {
        if (this.started) {
            log.info("VpnManager::StartedAlready");
            if (callback)
                 callback(null, this.portmapped, this.portmapped);
            return;
        }
        require('child_process').exec("sudo service openvpn start", (err, out, code) => {
            log.info("VpnManager:Start", err);
            if (err && this.started == false) {
                if (callback) {
                    callback(err);
                }
                return;
            }
            this.started = true;
            this.setNat(callback);
        });
    }

    generatePassword(len) {
        var length = len,
            charset = "0123456789",
            retVal = "";
        for (var i = 0, n = charset.length; i < length; ++i) {
            retVal += charset.charAt(Math.floor(Math.random() * n));
        }
        return retVal;
    }

    getOvpnFile(clientname, password, regenerate, callback) {

        fs.readFile("/home/pi/ovpns/" + clientname + ".ovpn", 'utf8', (err, ovpn) => {
            if (ovpn != null && regenerate == false) {
                let password = fs.readFileSync("/home/pi/ovpns/" + clientname + ".ovpn.password", 'utf8');
                log.info("VPNManager:Found older ovpn file");
                callback(null, ovpn, password);
                return;
            }

            if (regenerate == true) {
                clientname = clientname + this.generatePassword(10);
            }

            if (password == null) {
                password = this.generatePassword(5);
            }

                let ip = sysManager.myDDNS();
                if (ip == null) {
                    ip = sysManager.publicIp();
                }
                let cmd = "sudo ./ovpngen.sh " + clientname + " " + password + " " + sysManager.myIp() + " " + ip;
                log.info("VPNManager:GEN", cmd);
                this.getovpn = require('child_process').exec("cd /home/pi/firewalla/vpn; " + cmd + ";sync", (err, out, code) => {
                    if (err) {
                        log.error("VPNManager:INSTALL:Error", "Unable to install2.sh", err);
                    }
                    fs.readFile("/home/pi/ovpns/" + clientname + ".ovpn", 'utf8', (err, ovpn) => {
                        if (callback) {
                            callback(err, ovpn, password);
                        }
                    });
                });
        });
    }
}
