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
const iptable = require("../net2/Iptables");
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

const sem = require('../sensor/SensorEventManager.js').getInstance();
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

    setIptables(callback) {
        const serverNetwork = this.serverNetwork;
        const localIp = sysManager.myIp();
        log.info("VpnManager:SetIptables", serverNetwork, localIp);
        const commands =[
            `sudo iptables -w -t nat -C POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp} &>/dev/null && (sudo iptables -w -t nat -D POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp} || false)|| true`,
            `sudo iptables -w -t nat -I POSTROUTING 2 -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp}` // insert this rule next to first rule of POSTROUTING
        ];
        iptable.run(commands, null, callback);
    }

    unsetIptables(callback) {
        const serverNetwork = this.serverNetwork;
        const localIp = sysManager.myIp();
        log.info("VpnManager:UnsetIptables", serverNetwork, localIp);
        const commands =[
            `sudo iptables -w -t nat -C POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp} &>/dev/null && (sudo iptables -w -t nat -D POSTROUTING -s ${serverNetwork}/24 -o eth0 -j SNAT --to-source ${localIp} || false)|| true`,
        ];
        iptable.run(commands, callback);
    }

    unpunchNat(opts, callback) {
        log.info("VpnManager:UnpunchNat", opts);
        this.upnp.removePortMapping(opts.protocol, opts.private,opts.public,(err)=>{
            if (callback) {
                callback(err);
            }
        });
    }

    install(instance, callback) {
	let install1_cmd = util.format('cd %s/vpn; sudo -E ./install1.sh %s', fHome, instance);
        this.install1 = require('child_process').exec(install1_cmd, (err, out, code) => {
            if (err) {
                log.error("VPNManager:INSTALL:Error", "Unable to install1.sh for " +  instance, err);
            }
            if (err == null) {
                // !! Pay attention to the parameter "-E" which is used to preserve the
                // enviornment valueables when running sudo commands
                let install2_cmd = util.format("cd %s/vpn; sudo -E ./install2.sh %s", fHome, instance);
                log.info("VPNManager:INSTALL:cmd", install2_cmd);
                this.install2 = require('child_process').exec(install2_cmd, (err, out, code) => {
                    if (err) {
                        log.error("VPNManager:INSTALL:Error", "Unable to install2.sh", err);
                        if (callback) {
                            callback(err, null);
                        }
                        return;
                    }
                    log.info("VPNManager:INSTALL:Done");
                    this.instanceName = instance;
                    if (callback)
                        callback(null, null);
                });
            } else {
                if (callback) 
                    callback(err, null);
            }
        });
    }

    configure(config, callback) {
        if (config) {
            if (config.serverNetwork) {
                this.serverNetwork = config.serverNetwork;
            }
            if (config.localPort) {
                this.localPort = config.localPort;
            }
        }
        if (this.serverNetwork == null) {
            this.serverNetwork = this.generateNetwork();
        }
        if (this.localPort == null) {
            this.localPort = "1194";
        }
        if (this.instanceName == null) {
            this.instanceName = "server";
        }
        var mydns = sysManager.myDNS()[0]; 
        if (mydns == null) {
            mydns = "8.8.8.8"; // use google DNS as default
        }
        const cmd = util.format("cd %s/vpn; sudo -E ./confgen.sh %s %s %s %s %s",
            fHome, this.instanceName, sysManager.myIp(), mydns, this.serverNetwork, this.localPort);
        require('child_process').exec(cmd, (err, out, code) => {
            if (err) {
                log.error("VPNManager:CONFIGURE:Error", "Unable to generate server config for " + this.instanceName, err);
                if (callback)
                    callback(err);
                return;
            }
            log.info("VPNManager:CONFIGURE:Done");
            if (callback)
                callback(null);
        });
    }

    stop(callback) {
        this.started = false;
        this.unpunchNat({
            protocol: 'udp',
            private: this.localPort,
            public: this.localPort
        });
        require('child_process').exec("sudo systemctl stop openvpn@" + this.instanceName, (err, out, code) => {
            log.info("Stopping OpenVpn", err);
            if (err) {
                if (callback)
                    callback(err);
            } else {
                this.unsetIptables((err, result) => {
                    if (callback)
                        callback(err);
                });
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
            private: this.localPort,
            public: this.localPort,
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
                callback(null, external, this.localPort);
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
                 callback(null, this.portmapped, this.portmapped, this.serverNetwork, this.localPort);
            return;
        }

        if (this.instanceName == null) {
            callback("Server instance is not installed yet.");
            return;
        }

        this.upnp.gw = sysManager.myGateway();
        
        this.unpunchNat({
            protocol: 'udp',
            private: this.localPort,
            public: this.localPort
        },(err)=>{
            require('child_process').exec("sudo systemctl start openvpn@" + this.instanceName, (err, out, code) => {
                log.info("VpnManager:Start:" + this.instanceName, err);
                if (err && this.started == false) {
                    if (callback) {
                        callback(err);
                    }
                    return;
                }
                this.started = true;
                this.setIptables((err, result) => {
                    if (err) {
                        log.error("VpnManager:Start:Error", "Failed to set iptables", err);
                        this.stop();
                        if (callback) {
                            callback(err);
                        }                                
                    } else {
                        this.upnp.addPortMapping("udp",this.localPort,this.localPort,"Firewalla OpenVPN",(err)=>{ // public port and private port is equivalent by default
                            log.info("VpnManager:UPNP:SetDone", err);
                            sem.emitEvent({
                                type: "VPNSubnetChanged",
                                message: "VPN subnet is updated",
                                vpnSubnet: this.serverNetwork,
                                toProcess: "FireMain"
                            });
                            if (err) {
                                if (callback) {
                                    callback(null, null, null, this.serverNetwork, this.localPort);            
                                }
                            } else {
                                this.portmapped = true;
                                if (callback) {
                                    callback(null, "success", this.localPort, this.serverNetwork, this.localPort);
                                }
                            }
                        });
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

    generateNetwork() {
        // random segment from 20 to 199
        const seg1 = Math.floor(Math.random() * 180 + 20);
        const seg2 = Math.floor(Math.random() * 180 + 20);
        return "10." + seg1 + "." + seg2 + ".0";
    }

    getOvpnFile(clientname, password, regenerate, callback) {
        let ovpn_file = util.format("%s/ovpns/%s.ovpn", process.env.HOME, clientname);
        let ovpn_password = util.format("%s/ovpns/%s.ovpn.password", process.env.HOME, clientname);

        log.info("Reading ovpn file", ovpn_file,ovpn_password,regenerate);
        
        fs.readFile(ovpn_file, 'utf8', (err, ovpn) => {
            if (ovpn != null && regenerate == false) {
                let password = fs.readFileSync(ovpn_password, 'utf8');
                log.info("VPNManager:Found older ovpn file: " + ovpn_file);
                callback(null, ovpn, password);
                return;
            }

            let originalName = clientname;
            // Original name remains unchanged even if client name is trailed by random numbers.
            // So that client ovpn file name will remain unchanged while its content has been updated.
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

            let cmd = util.format("cd %s/vpn; flock -n %s -c 'sudo -E ./ovpngen.sh %s %s %s %s %s'; sync", 
                fHome, vpnLockFile, clientname, password, ip, this.localPort, originalName);
            log.info("VPNManager:GEN", cmd);
            this.getovpn = require('child_process').exec(cmd, (err, out, code) => {
                if (err) {
                    log.error("VPNManager:GEN:Error", "Unable to ovpngen.sh", err);
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
