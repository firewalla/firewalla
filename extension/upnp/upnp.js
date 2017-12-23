/**
 * Created by Melvin Tu on 05/01/2017.
 */


'use strict';
 
let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');

let f = require('../../net2/Firewalla.js');

let natpmp = require('nat-pmp');
let natupnp = require('nat-upnp');

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
 
    /* return if NATPMP or UPNP 
     *  
     */
    getCapability(callback) {
        upnpClient.externalIp((err,ip)=>{
            if (err !=null || ip == null) {
                this.upnpEnabled = false;
                this.natpmpClient = natpmp.connect(this.gw);
                if (this.natpmpClient) {
                    this.natpmpClient.externalIp((err, info)=> {
                        if (err == null && info!=null) { 
                            this.natpmpIP = info.ip.join('.');
                            this.natpmpEnabled = true;
                        } else {
                            this.natpmpEnabled = false;
                        }
                        this.natpmpClient.close();
                        this.natpmpClient = null;
                        callback(null, this.upnpEnabled, this.natpmpEnabled);
                    });
                }
            } else {
                this.upnpIP = ip;
                this.upnpEnabled = true;
                callback(null, this.upnpEnabled, this.natpmpEnabled);
            } 
        });
    } 

    addPortMapping(protocol, localPort, externalPort, description, callback) {
        this.getCapability(()=>{
            if (this.upnpEnabled == true) {
                return this.addPortMappingUPNP(protocol, localPort, externalPort, description, callback);
            } else if (this.natpmpEnabled == true) {
                return this.addPortMappingNATPMP(protocol, localPort, externalPort, description, callback);
            } else {
                callback(new Error("no upnp/natpmp"));
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
        this.natpmpClient = natpmp.connect(this.gw);
        if (this.natpmpClient == null) {
            callback(new Error("natpmpClient null"),null);
            return;
        }
        this.natpmpClient.portMapping({ private: localPort, public: externalPort, ttl: natpmpTimeout}, (err, info)=> {
            if (err == null) {
                this.refreshTimers[localPort+":"+externalPort] = setTimeout(()=>{
                    this.addPortMappingNATPMP(protocol,localPort, externalPort, description,()=>{
                    });  
                }, natpmpTimeout/2); 
            }
            this.natpmpClient.close();
            this.natpmpClient = null;
            callback(err,info);
        });
    }

    removePortMappingNATPMP(protocol, localPort, externalPort, callback) {
        callback = callback || function() {};
        let timer = this.refreshTimers[localPort+":"+externalPort];
        this.natpmpClient = natpmp.connect(this.gw);
        if (this.natpmpClient == null) {
            callback(new Error("natpmpClient null"),null);
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        this.natpmpClient.portUnMapping({ private: localPort, public: externalPort, ttl: 0}, (err, info)=> {
            this.natpmpClient.close();
            this.natpmpClient = null;
            callback(err,info);
        });
    }

    removePortMapping(protocol, localPort, externalPort, callback) {
        this.getCapability(()=>{
            if (this.upnpEnabled == true) {
                return this.removePortMappingUPNP(protocol, localPort, externalPort,callback);
            } else if (this.natpmpEnabled == true) {
                return this.removePortMappingNATPMP(protocol, localPort, externalPort, callback);
            } else {
                callback(new Error("no upnp/natpmp"));
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
                log.error("Failed to remove port mapping: " + err);
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



