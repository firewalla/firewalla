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
let log = require('./logger.js')(__filename);

var iptool = require('ip');
var os = require('os');
var network = require('network');
var instance = null;
var fs = require('fs');

let sem = require('../sensor/SensorEventManager.js').getInstance();

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

var bone = require("../lib/Bone.js");
var systemDebug = false;

let DNSServers = {
    "75.75.75.75": true,
    "75.75.75.76": true,
    "8.8.8.8": true
};

let f = require('../net2/Firewalla.js');

let i18n = require('../util/i18n.js');

const MAX_CONNS_PER_FLOW = 25000;

const dns = require('dns');

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            rclient.hdel("sys:network:info", "oper");
            this.multicastlow = iptool.toLong("224.0.0.0");
            this.multicasthigh = iptool.toLong("239.255.255.255");
            this.locals = {};
            this.lastIPTime = 0;
            instance = this;

          sclient.on("message", function(channel, message) {
            switch(channel) {
            case "System:DebugChange":
              if(message === "1") {
                systemDebug = true;
              } else if(message === "0") {
                systemDebug = false;
              } else {
                log.error("invalid message for channel: " + channel);
                return;
              }
              log.info("[pubsub] System Debug is changed to " + message);
              break;
            case "System:LanguageChange":
              this.language = message;
              i18n.setLocale(this.language);
              break;
            case "System:TimezoneChange":
              this.timezone = message;
            }
          });
          sclient.subscribe("System:DebugChange");

          this.delayedActions();

          fs.readFile('/encipher.config/license','utf8',(err,_data)=> {
            let license = null;
            if (_data) {
              license = JSON.parse(_data);
            }
            this.license = license;
          });
          
          sem.on("PublicIP:Updated", (event) => {
            if(event.ip)
              this.publicIp = event.ip;
          });
        }
        this.update(null);
        return instance;
    }

  // config loaded && interface discovered
  isConfigInitialized() {
    return this.config != null && 
      this.config.monitoringInterface && 
      this.config[this.config.monitoringInterface] !== null;
  }
  
    delayedActions() {
        setTimeout(()=>{
          let SSH = require('../extension/ssh/ssh.js');
          let ssh = new SSH('info');

          ssh.getPassword((err, password) => {
              this.sshPassword = password; 
          });
        },2000); 
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
        log.info("Calling release function of SysManager");
    }
    
    debugOn(callback) {
        rclient.set("system:debug", "1", (err) => {
            systemDebug = true;
            rclient.publish("System:DebugChange", "1"); 
            callback(err);
        });
    }

    debugOff(callback) {
        rclient.set("system:debug", "0", (err) => {
            systemDebug = false;
            rclient.publish("System:DebugChange", "0"); 
            callback(err);
        });
    }

    isSystemDebugOn() {
        return systemDebug;
    }

    systemRebootedDueToIssue(reset) {
       try {
           if (require('fs').existsSync("/home/pi/.firewalla/managed_reboot")) { 
               log.info("SysManager:RebootDueToIssue");
               if (reset == true) { 
                   require('fs').unlinkSync("/home/pi/.firewalla/managed_reboot");
               }
               return true;
           }
       } catch(e) {
           return false;
       }
       return false;
    }

  setLanguage(language, callback) {
    callback = callback || function() {}

    this.language = language;
    i18n.setLocale(this.language);
    rclient.hset("sys:config", "language", language, (err) => {
      if(err) {
        log.error("Failed to set language " + language + ", err: " + err);
      }
      rclient.publish("System:LanguageChange", language);
      callback(err);
    });
  }
  
  setTimezone(timezone, callback) {
    callback = callback || function() {}

    this.timezone = timezone;
    rclient.hset("sys:config", "timezone", timezone, (err) => {
      if(err) {
        log.error("Failed to set timezone " + timezone + ", err: " + err);
      }
      rclient.publish("System:TimezoneChange", timezone);
      callback(err);
    });
  }
  
  update(callback) {
    log.debug("Loading sysmanager data from redis");
    rclient.hgetall("sys:config", (err, results) => {
      if(results && results.language) {
        this.language = results.language;
        i18n.setLocale(this.language);
      }

      if(results && results.timezone) {
        this.timezone = results.timezone;
      }
    });
    
        rclient.get("system:debug", (err, result) => {
            if(result) {
                if(result === "1") {
                    systemDebug = true;
                } else {
                    systemDebug = false;
                }
            } else {
                // by default off
                systemDebug = false;
            }
        });

        rclient.hgetall("sys:network:info", (err, results) => {
            if (err == null) {
                this.sysinfo = results;

                if(this.sysinfo === null) {
                    return;
                }

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
                var self = this;
                //         log.info("System Manager Initialized with Config", this.sysinfo);
            }
            if (callback != null) {
                callback(err);
            }
        });
    }

    setConfig(config) {
        return rclient.hsetAsync("sys:network:info", "config", JSON.stringify(config))
          .then(() => {
            this.config = config;
          }).catch((err) => {
            log.error("Failed to set sys:network:info in redis", err, {});
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
          //log.info(require('util').inspect(this.sysinfo, {depth: null}));
          return this.sysinfo && this.sysinfo[this.config.monitoringInterface];
        }
    }

    myIp() {
        if(this.monitoringInterface()) {
            return this.monitoringInterface().ip_address;            
        } else {
            return undefined;
        }
    }

    myIpMask() {
        if(this.monitoringInterface()) {
            let mask =  this.monitoringInterface().netmask;            
            if (mask.startsWith("Mask:")) {
                mask = mask.substr(5);
            }
            return mask;
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


    myDNS() { // return array
        let _dns = (this.monitoringInterface() && this.monitoringInterface().dns) || [];
        let v4dns = [];
        for (let i in _dns) {
            if (iptool.isV4Format(_dns[i])) {
                v4dns.push(_dns[i]);
            }
        } 
        return v4dns;
    }

    myDNSAny() {
        return this.monitoringInterface().dns;
    }

    myGateway() {
        return this.monitoringInterface().gateway;
    }

    mySubnet() {
        return this.monitoringInterface().subnet;
    }

    mySubnetNoSlash() {
        let subnet = this.mySubnet();
        return subnet.substring(0, subnet.indexOf('/'));
    }

    mySSHPassword() {
        return this.sshPassword;
    }

    inMySubnet6(ip6) {
        let ip6_masks = this.monitoringInterface().ip6_masks;
        let ip6_addresses = this.monitoringInterface().ip6_addresses;

        if (ip6_masks == null) {
            return false;
        }

        for (let m in ip6_masks) {
            let mask = iptool.mask(ip6_addresses[m],ip6_masks[m]);
            if (mask == iptool.mask(ip6,ip6_masks[m])) {
                log.info("SysManager:FoundSubnet", ip6,mask);
                return true;
            }
        }
        return false;
    }

    // hack ... 
    debugState(component) {
        if (component == "FW_HASHDEBUG") {
            return true;
        }
        return false;
    }

    // serial may not come back with anything for some platforms 

    getSysInfo(callback) {
      let serial = null;
      if (fs.existsSync("/.dockerenv")) {
        serial = require('child_process').execSync("basename \"$(head /proc/1/cgroup)\" | cut -c 1-12").toString().replace(/\n$/, '')
      } else {
        serial = require('fs').readFileSync("/sys/block/mmcblk0/device/serial",'utf8');
      }

        if (serial != null) {
            serial = serial.trim();
        }
        let stat = require("../util/Stats.js");
        stat.sysmemory(null,(err,data)=>{
            callback(null,{
               ip: this.myIp(),
               mac: this.myMAC(),
               serial: serial,
               memory: data
            });
        });
    }

    // if the ip is part of our cloud, no need to log it, since it might cost space and memory
    isMyServer(ip) {
        if (this.serverIps) {
            return (this.serverIps.indexOf(ip)>-1);
        } else {
            dns.resolve4('firewalla.encipher.io', (err, addresses) => {
                 this.serverIps = addresses;
            }); 
            setInterval(()=>{
                 this.serverIps = null;
            },1000*60*60*24);
            return false;
        }
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


    isLocalIP4(intf, ip) {
        if (this.sysinfo[intf]==null) {
           return false;
        }

        let subnet = this.sysinfo[intf].subnet;
        if (subnet == null) {
            return false;
        }

        if (this.isMulticastIP(ip)) {
            return true;
        }

        return iptool.cidrSubnet(subnet).contains(ip);
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

            return iptool.cidrSubnet(this.subnet).contains(ip) || this.isLocalIP4(this.config.monitoringInterface2,ip);
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
            return this.inMySubnet6(ip);
        } else {
            log.debug("SysManager:ERROR:isLocalIP", ip);
            return true;
        }
    }

    ipLearned(ip) {
        if (this.locals[ip]) {
            return true;
        } else {
            return false;
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
};
