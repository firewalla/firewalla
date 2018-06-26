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
const log = require("../net2/logger.js")(__filename)
var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');
var firewalla = require('../net2/Firewalla.js');
var fHome = firewalla.getFirewallaHome();

var later = require('later');
var publicIp = require('public-ip');

var fs = require('fs');
var network = require('network');
var natpmp = require('nat-pmp');
var natupnp = require('nat-upnp');
var ipTool = require('ip');
var async = require('async');

var util = require('util');

var linux = require('../util/linux');
var UPNP = require('../extension/upnp/upnp.js');

var ttlExpire = 12*60*60;

module.exports = class {
    constructor() {
        if (instance == null) {
            this.upnp = new UPNP("info",sysManager.myGateway());
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
        linux.gateway_ip((err, gateway) => {
            if (err) return error(err)
            log.info("VpnManager:PublicGateway Checking",gateway,gateway.trim(),gateway.length);
            if (ipTool.isPublic(gateway.trim())==true) {
                log.info("VpnManager:PublicGateway True",gateway);
                return success(gateway)
            }

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
                setTimeout(() => {
                    if (this.upnpClient) {
                        this.upnpClient.close();
                        this.upnpClient = null;
                    } else {
                        log.error("VpnManager:NatUPNP resetupnp client null");
                    }
                },1000);
            });
        });
    }

    unpunchNat(opts, callback) {
        log.info("VpnManager:UnpunchNat", opts);
        this.upnp.removePortMapping(opts.protocol, opts.private,opts.public,(err)=>{
            if (callback) {
                callback(err);
            }
        });
    }

    install(callback) {
	let install1_cmd = util.format('cd %s/vpn; sudo -E ./install1.sh', fHome);
        this.install1 = require('child_process').exec(install1_cmd, (err, out, code) => {
            if (err) {
                log.error("VPNManager:INSTALL:Error", "Unable to install1.sh", err);
            }
            if (err == null) {
                publicIp.v4((err, ip) => {
                    if (err != null) {
                        log.error("VPNManager:INSTALL:Error IP",ip,err);
                        ip = sysManager.myDDNS();
                        if (ip == null) {
                             ip = sysManager.publicIp;
                        }
                        if (ip == null) {
                            if (callback) 
                                callback(err, null);
                            return;
                        }
                    }

                    // !! Pay attention to the parameter "-E" which is used to preserve the
                    // enviornment valueables when running sudo commands
                    
                    var mydns = sysManager.myDNS()[0]; 
                    if (mydns == null) {
                        mydns = "8.8.8.8"; // use google DNS as default
                    }
                    let install2_cmd = util.format("cd %s/vpn; sudo -E ./install2.sh %s %s", fHome, sysManager.myIp(), ip, mydns);
                    log.info("VPNManager:INSTALL:cmd", install2_cmd);
                    this.install2 = require('child_process').exec(install2_cmd, (err, out, code) => {
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
        require('child_process').exec("sudo systemctl stop openvpn@server", (err, out, code) => {
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
            ttl: 0,
            description: "Firewalla VPN"
        }, (external) => {
            log.info("VpnManager:Start:portMap", external);
            setTimeout(() => {
                log.info("VpnManager:Restart:portMap");
                this.setNat(null)
            }, ttlExpire/3*1000);
            if (callback) {
                this.portmapped = true;
                callback(null, external, 1194);
            }
        }, (err) => {
            log.info("VpnManager:Start:portMap:Failed: " + err);
            setTimeout(() => {
                log.info("VpnManager:Restart:portMap");
                this.setNat(null)
            }, ttlExpire/3*1000);
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

        this.upnp.gw = sysManager.myGateway();
        
        this.unpunchNat({
            protocol: 'udp',
            private: 1194,
            public: 1194
        },(err)=>{
            require('child_process').exec("sudo systemctl start openvpn@server", (err, out, code) => {
                log.info("VpnManager:Start", err);
                if (err && this.started == false) {
                    if (callback) {
                        callback(err);
                    }
                    return;
                }
                this.started = true;
                this.upnp.addPortMapping("udp",1194,1194,"Firewalla OpenVPN",(err)=>{
                   log.info("VpnManager:UPNP:SetDone", err);
                   if (err) {
                       callback(null,null,null);            
                   } else {
                       this.portmapped = true;
                       callback(null,"success",1194);
                   }
                }); 
            });
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
        let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, clientname);
        let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, clientname);

        log.info("Reading ovpn file", ovpn_file,ovpn_password,regenerate);
        
        fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
            if (ovpn != null && regenerate == false) {
                let password = fs.readFileSync(ovpn_password, 'utf8');
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
                ip = sysManager.publicIp;
            }

            var mydns = sysManager.myDNS()[0]; 
            if (mydns == null) {
                mydns = "8.8.8.8"; // use google DNS as default
            }
            
            const vpnLockFile = "/dev/shm/vpn_gen_lock_file";

            let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s'; sync", fHome, vpnLockFile, clientname, password, sysManager.myIp(), ip, mydns);
            log.info("VPNManager:GEN", cmd);
            this.getovpn = require('child_process').exec(cmd, (err, out, code) => {
                if (err) {
                    log.error("VPNManager:INSTALL:Error", "Unable to install2.sh", err);
                }
                fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
                    if (callback) {
                        callback(err, ovpn, password);
                    }
                });
            });
        });
    }
}
