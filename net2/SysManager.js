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
var log;
var iptool = require('ip');
var os = require('os');
var network = require('network');
var instance = null;

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

var bone = require("../lib/Bone.js");


let DNSServers = {
    "75.75.75.75": true,
    "75.75.75.76": true,
    "8.8.8.8": true
};

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("./logger.js")("SysManager", loglevel);
            rclient.hdel("sys:network:info", "oper");
            this.multicastlow = iptool.toLong("224.0.0.0");
            this.multicasthigh = iptool.toLong("239.255.255.255");
            this.locals = {};
            instance = this;
        }
        this.update(null);
        return instance;
    }

    version() {
        if (this.config != null && this.config.version != null) {
            return this.config.version;
        } else {
            return "unknown";
        }
    }

    setNeighbor(ip) {
        this.locals[ip] = "1";
        log.debug("Sys:Insert:Local", ip, "***");
    }

    /**
     * Only call release function when the SysManager instance is no longer
     * needed
     */
    release() {
        rclient.quit();
        sclient.quit();
        console.log("Calling release function of SysManager");
    }

    getPublicIP(callback) {
        var ip = this.publicIp;
        let self = this;
        if (ip == null) {
            var getIP = require('external-ip')();
            getIP(function(err, ip2) {
                if(err == null) {
                    self.publicIp = ip2;
                    callback(undefined, ip2);
                } else {
                    callback(err, undefined);
                }
            })
        } else {
            callback(undefined, ip);
        }
    }
    
    update(callback) {
        rclient.hgetall("sys:network:info", (err, results) => {
            if (err == null) {
                this.sysinfo = results;
                for (let r in this.sysinfo) {
                    this.sysinfo[r] = JSON.parse(this.sysinfo[r]);
                }
                if (this.sysinfo['config'] != null) {
                    // this.config = JSON.parse(this.sysinfo['config']);
                    this.config = this.sysinfo['config'];
                }
                if (this.sysinfo['oper'] == null) {
                    this.sysinfo.oper = {};
                }
                this.ddns = this.sysinfo["ddns"];
                this.publicIp = this.sysinfo["publicIp"];
                var getIP = require('external-ip')();
                var self = this;
                getIP(function(err,ip) {
                    if(err == null) {
                        self.publicIp = ip;
                    }
                });
                //         console.log("System Manager Initialized with Config", this.sysinfo);
            }
            if (callback != null) {
                callback(err);
            }
        });
    }

    setConfig(config) {
        rclient.hset("sys:network:info", "config", JSON.stringify(config), (err, result) => {
            if (err == null) {
                this.config = config;
                //log.info("System Configuration Upgraded");
            }
        });
    }

    setOperationalState(state, value) {
        this.update((err) => {
            this.sysinfo['oper'][state] = value;
            rclient.hset("sys:network:info", "oper", JSON.stringify(this.sysinfo['oper']), (err, result) => {
                if (err == null) {
                    //log.info("System Operational Changed",state,value,this.sysinfo['oper']);
                }
            });
        });
    }

    monitoringInterface() {
        if (this.config) {
            return this.sysinfo[this.config.monitoringInterface];
        }
    }

    myIp() {
        if(this.monitoringInterface()) {
            return this.monitoringInterface().ip_address;            
        } else {
            return undefined;
        }
    }

    myMAC() {
        if (this.monitoringInterface()) {
            return this.monitoringInterface().mac_address;
        } else {
            return null;
        }
    }
 
    myDDNS() {
        return this.ddns;
    }


    myDNS() {
        return this.monitoringInterface().dns;
    }

    getSysInfo(callback) {
              callback(null,{
                ip: this.myIp(),
                mac: this.myMAC(),
              });
    }

    isMulticastIP4(ip) {
        try {
            if (!iptool.isV4Format(ip)) {
                return false;
            }
            if (ip == "255.255.255.255") {
                return true;
            }
            return (iptool.toLong(ip) >= this.multicastlow && iptool.toLong(ip) <= this.multicasthigh)
        } catch (e) {
            log.error("SysManager:isMulticastIP4", ip, e);
            return false;
        }
    }

    isMulticastIP6(ip) {
        return ip.startsWith("ff");
    }

    isMulticastIP(ip) {
        try {
            if (iptool.isV4Format(ip)) {
                return this.isMulticastIP4(ip);
            } else {
                return this.isMulticastIP6(ip);
            }
        } catch (e) {
            log.error("SysManager:isMulticastIP", ip, e);
            return false;
        }
    }

    isDNS(ip) {
        if (DNSServers[ip] != null) {
            return true;
        }
        return false;
    }

    isLocalIP(ip) {
        if (iptool.isV4Format(ip)) {

            if (this.subnet == null) {
                this.subnet = this.sysinfo[this.config.monitoringInterface].subnet;
            }
            if (this.subnet == null) {
                log.error("SysManager:Error getting subnet ");
                return true;
            }

            if (this.isMulticastIP(ip)) {
                return true;
            }

            return iptool.cidrSubnet(this.subnet).contains(ip);
        } else if (iptool.isV6Format(ip)) {
            if (ip.startsWith('::')) {
                return true;
            }
            if (this.isMulticastIP6(ip)) {
                return true;
            }
            if (ip.startsWith('fe80')) {
                return true;
            }
            if (this.locals[ip]) {
                return true;
            }
            return false;
        } else {
            log.error("SysManager:ERROR:isLocalIP", ip);
            return true;
        }
    }

    ignoreIP(ip) {
        if (this.isDNS(ip)) {
            return true;
        }
        return false;
    }

    isSystemDomain(ipOrDomain) {
        if (ipOrDomain.indexOf('encipher.io') > -1) {
            return true;
        }
        return false;
    }

    checkIn(callback) {
        this.getSysInfo((err,data)=>{
            bone.checkin(this.config,data,(err,data)=>{
                console.log("CheckedIn:", data);
                if (data.ddns) {
                    this.ddns = data.ddns;
                    rclient.hset("sys:network:info", "ddns", JSON.stringify(data.ddns), (err, result) => {
                         if (callback) {
                             callback(null,null);
                         }
                    });
                }
                if (data.publicIp) {
                    this.publicIp = data.publicIp;
                    rclient.hset("sys:network:info", "publicIp", JSON.stringify(data.publicIp), (err, result) => {
                    });
                }
            });
        });

    }

    redisclean() {
        rclient.keys("flow:conn:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.conn.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                //console.log("Expring for ",keys[k],expireDate);
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //    log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
                rclient.zcount(keys[k],'-inf','+inf',(err,data) => {
                     log.info("REDISCLEAN: flow:conn ",keys[k],data);
                });
            }
        });
        rclient.keys("flow:ssl:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.ssl.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("flow:http:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.http.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("notice:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.notice.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("intel:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.intel.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
                rclient.zremrangebyrank(keys[k], 0, -20, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("software:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.software.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],err,data);
                });
            }
        });
        rclient.keys("monitor:flow:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 8 * 60 * 60;
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("alarm:ip4:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 60 * 60 * 24 * 7;
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
                rclient.zremrangebyrank(keys[k], 0, -20, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
    }

};
