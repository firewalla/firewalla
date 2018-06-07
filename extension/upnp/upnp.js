/*    Copyright 2017 Firewalla LLC
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
/**
 * Created by Melvin Tu on 05/01/2017.
 */

/*
 * WARNING:
 *   UPNP operations must be isolated to be one process.  NATPMP requires
 *   openning a port, which may cause trouble if two processes are doing
 *   the same 
 */

'use strict';
 
let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');

let f = require('../../net2/Firewalla.js');

let natpmp = require('./nat-pmp');
let natupnp = require('./nat-upnp');

let upnpClient = natupnp.createClient();
//upnpClient.timeout = 10000; // set timeout to 10 seconds to avoid timeout too often
let natpmpTimeout = 86400;

module.exports = class {
    constructor(loglevel,gw) {
        if (instance == null) {
            log = require("../../net2/logger.js")("upnp.js", loglevel || "info");
            this.gw = gw;
            instance = this;
            this.refreshTimers = {};
        }
        return instance;
    }

    natpmpClient() {
        try {
            if (this._natpmpClient == null) {
                this._natpmpClient = natpmp.connect(this.gw);
            }
            return this._natpmpClient;
        } catch(e) {
            log.error("UPNP:natpmpClient Unable to initalize", e,{});
        }
    }
 
    /* return if NATPMP or UPNP 
     *  
     */
    getCapability(callback) {
      try {
        upnpClient.externalIp((err,ip)=>{
            if (err !=null || ip == null) {
                this.upnpEnabled = false;
                if (this.natpmpClient()) {

                    let timeout = true;
                    setTimeout(() => {
                        if(timeout) {
                            callback(null, this.upnpEnabled, false)
                        }
                    }, 5 * 1000)

                    this.natpmpClient().externalIp((err, info)=> {
                        if (err == null && info!=null) { 
                            this.natpmpIP = info.ip.join('.');
                            this.natpmpEnabled = true;
                        } else {
                            this.natpmpEnabled = false;
                        }
                        timeout = false
                        callback(null, this.upnpEnabled, this.natpmpEnabled);
                    });
                }
            } else {
                this.upnpIP = ip;
                this.upnpEnabled = true;
                callback(null, this.upnpEnabled, this.natpmpEnabled);
            } 
        });
      } catch(e) {
        log.error("UPNP.getCapability exception ", e,{});
      }
      
    } 

    addPortMapping(protocol, localPort, externalPort, description, callback) {
        this.getCapability(()=>{
            try {
                if (this.upnpEnabled == true) {
                    return this.addPortMappingUPNP(protocol, localPort, externalPort, description, callback);
                } else if (this.natpmpEnabled == true) {
                    return this.addPortMappingNATPMP(protocol, localPort, externalPort, description, callback);
                } else {
                    callback(new Error("no upnp/natpmp"));
                }
            } catch(e) {
                log.error("UPNP.addPortMapping exception",e,{});
            }
        });
    }

    addPortMappingUPNP(protocol, localPort, externalPort, description, callback) {
        callback = callback || function() {};
        upnpClient.portMapping({
            type: protocol,
            protocol: protocol,
            private: localPort,
            public: externalPort,
            ttl: 0, // set ttl to 0 for better compatibility
            description: description
        }, (err) => {
           if(err) {
             log.error("Failed to add port mapping ", description, " :", err);
               if(callback) {
                   callback(err);
               }
               return;
           }
           log.info(util.format("Port mapping [%s, %s, %s] is added successfully.",
               protocol, localPort, externalPort));

           if(callback) {
               callback();
           }

        });
    }
 
    addPortMappingNATPMP(protocol, localPort, externalPort, description, callback) {
        callback = callback || function() {};
        if (this.natpmpClient() == null) {
            callback(new Error("natpmpClient null"),null);
            return;
        }
        this.natpmpClient().portMapping({type:protocol, private: localPort, public: externalPort, ttl: natpmpTimeout}, (err, info)=> {
            if (err == null) {
                this.refreshTimers[localPort+":"+externalPort] = setTimeout(()=>{
                    this.addPortMappingNATPMP(protocol,localPort, externalPort, description,()=>{
                    });  
                }, natpmpTimeout/2*1000); 
            }
            callback(err,info);
        });
    }

    removePortMappingNATPMP(protocol, localPort, externalPort, callback) {
        callback = callback || function() {};
        let timer = this.refreshTimers[localPort+":"+externalPort];
        if (this.natpmpClient() == null) {
            callback(new Error("natpmpClient null"),null);
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        this.natpmpClient().portUnmapping({ type:protocol, private: localPort, public: externalPort, ttl: 0}, (err, info)=> {
            if (err) {
                log.error("UPNP.removePortMappingNATPMP",err,{});
            }
            callback(err,info);
        });
    }

    removePortMapping(protocol, localPort, externalPort, callback) {
       callback = callback || function() {}
        this.getCapability(()=>{
            try {
                if (this.upnpEnabled == true) {
                    return this.removePortMappingUPNP(protocol, localPort, externalPort,callback);
                } else if (this.natpmpEnabled == true) {
                    return this.removePortMappingNATPMP(protocol, localPort, externalPort, callback);
                } else {
                    if (typeof callback === 'function') {
                        callback(new Error("no upnp/natpmp"));
                    }
                }
            } catch(e) {
                log.error("UPNP.removePortMapping Exception",e,{});
            }
        });
    }

    removePortMappingUPNP(protocol, localPort, externalPort, callback) {
        callback = callback || function() {};
    
        upnpClient.portUnmapping({
            protocol: protocol,
            private: localPort,
            public: externalPort
        }, (err) => {
            if(err) {
                log.error("UPNP Failed to remove port mapping: " + err);
                if(callback) {
                    callback(err);
                }
                return;
            }

            log.info(util.format("Port mapping [%s, %s, %s] is removed successfully"
                , protocol, localPort, externalPort));

            if(callback) {
                callback();
            }
        });
    }

    getLocalPortMappings(description, callback) {
        upnpClient.getMappings({
            // local: true,
            // description: description
        }, (err, results) => {
            callback(err, results);
        });
    }

    hasPortMapping(protocol, localPort, externalPort, description, callback) {
        upnpClient.getMappings({
            // local: true
            // description: description
        }, (err, results) => {
            if(err) {
                log.error("Failed to get upnp mappings");
                callback(err);
                return;
           }
            console.log(util.inspect(results));
           let matches = results.filter((r) => {
                console.log(r);
               return r.public.port === externalPort &&
                       r.private.port === localPort &&
                       r.protocol === protocol &&
                       r.description === description;
            });

            console.log(util.inspect(matches));
            if(matches.length > 0) {
                callback(null, true);
            } else {
                callback(null, false);
            }
        });
   }
}



