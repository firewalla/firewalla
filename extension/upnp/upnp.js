/**
 * Created by Melvin Tu on 05/01/2017.
 */


'use strict';
 
let instance = null;
let log = null;

let fs = require('fs');
let util = require('util');

let Firewalla = require('../../net2/Firewalla.js');
let f = new Firewalla("config.json", 'info');

let natpmp = require('nat-pmp');
let natupnp = require('nat-upnp');

let upnpClient = natupnp.createClient();
upnpClient.timeout = 10000; // set timeout to 10 seconds to avoid timeout too often

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("upnp.js", loglevel || "info");

            instance = this;
        }
        return instance;
    }

    addPortMapping(protocol, localPort, externalPort, description, callback) {
        upnpClient.portMapping({
            type: protocol,
            protocol: protocol,
            private: localPort,
            public: externalPort,
            ttl: 0,
            description: description
        }, (err) => {
           if(err) {
               log.error("failed to add port mapping: " + err);
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

    removePortMapping(protocol, localPort, externalPort, callback) {
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
 