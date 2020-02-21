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

const log = require("../../net2/logger.js")(__filename);
const util = require('util');

const sysManager = require('../../net2/SysManager.js');

const _ = require('lodash');

const natpmp = require('./nat-pmp');
const natupnp = require('./nat-upnp');

const upnpClient = natupnp.createClient();
//upnpClient.timeout = 10000; // set timeout to 10 seconds to avoid timeout too often
const natpmpTimeout = 86400;  // 1 day = 24 * 60 * 60 seconds

let upnpMappings = [];
const upnpCheckInterval = 15 * 60 * 1000 // 15 mins

module.exports = class {
  constructor(gw) {
    if (instance == null) {
      if (gw)
        this.gw = gw;
      else
        this.gw = sysManager.myDefaultGateway();

      instance = this;
      this.refreshTimers = {};

      // TODO: move this to UPNPSensor
      // periodical checks whether all upnp mappings registered are alive
      // if not, adds back
      if (process.title === "FireMain") {
        this.upnpIntervalHandler = setInterval(
          () => {
            log.info("UPnP periodical check starts")
            if (upnpMappings.isEmpty) {
              log.info("No mapping registered.")
              return;
            }
            upnpClient.getMappings((err, results) => {
              if (err) {
                log.error("Failed to get current mappings", err);
                return;
              }
              log.info("Current mappings: ", results);

              upnpMappings.forEach((check) => {
                log.info("Checking registered mapping:", check);
                if (_.isEmpty(
                  results.find((m) => this.mappingCompare(m, check))
                )) {
                  log.info("Mapping no longer exists, adding back to router...")
                  let { protocol, localPort, externalPort, description } = check;
                  this.addPortMappingUPNP(protocol, localPort, externalPort, description)
                } else {
                  log.info("Mapping still exists")
                }
              })
            })
          },
          upnpCheckInterval
        )
      }
    }
    return instance;
  }

  natpmpClient() {
    try {
      if (this._natpmpClient == null) {
        this._natpmpClient = natpmp.connect(this.gw);
        this._natpmpClient.on('error', err => {
          log.error("natpmp emitted", err);
        });
      }
      return this._natpmpClient;
    } catch (e) {
      log.error("UPNP:natpmpClient Unable to initalize", e);
    }
  }

  /* return if NATPMP or UPNP
   *
   */
  getCapability(callback) {
    callback = callback || function() { };
    try {
      upnpClient.externalIp((err, ip) => {
        if (err != null || ip == null) {
          log.info('UPnP test failed')
          this.upnpEnabled = false;
          if (this.natpmpClient()) {

            this.natpmpClient().externalIp((err, info) => {
              if (err == null && info != null) {
                this.natpmpIP = info.ip.join('.');
                log.info('NAT-PMP test passed')
                this.natpmpEnabled = true;
              } else {
                log.info('NAT-PMP test failed')
                this.natpmpEnabled = false;
              }
              callback(null, this.upnpEnabled, this.natpmpEnabled);
            });
          }
        } else {
          this.upnpIP = ip;
          this.upnpEnabled = true;
          log.info('UPnP test passed')
          callback(null, this.upnpEnabled, this.natpmpEnabled);
        }
      });
    } catch (e) {
      log.error("UPNP.getCapability exception ", e);
    }

  }

  addPortMapping(protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function() { };
    this.getCapability(() => {
      try {
        if (this.upnpEnabled == true) {
          return this.addPortMappingUPNP(protocol, localPort, externalPort, description, callback);
        } else if (this.natpmpEnabled == true) {
          return this.addPortMappingNATPMP(protocol, localPort, externalPort, description, callback);
        } else {
          callback(new Error("no upnp/natpmp"));
        }
      } catch (e) {
        log.error("UPNP.addPortMapping exception", e);
        callback(e);
      }
    });
  }

  addPortMappingUPNP(protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };

    upnpClient.portMapping({
      type: protocol,
      protocol: protocol,
      private: { host: sysManager.myDefaultWanIp(), port: localPort },
      public: externalPort,
      ttl: 0, // set ttl to 0 for better compatibility
      description: description
    }, (err) => {
      if (err) {
        log.error("Failed to add port mapping ", description, " :", err);
        callback(err);
        return;
      }
      log.info(util.format("Port mapping [%s, %s, %s] is added successfully.",
        protocol, localPort, externalPort));

      let mappingObj = { protocol, localPort, externalPort, description };

      // check if mapping registered
      if (_.isEmpty(upnpMappings.find((m) =>
        m.localPort     == localPort &&
        m.externalPort  == externalPort &&
        m.protocol      === protocol
      ))) {
        upnpMappings.push(mappingObj);
      } else {
        log.info("Mapping handler already exists");
      }

      callback();
    });
  }

  addPortMappingNATPMP(protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };
    if (this.natpmpClient() == null) {
      callback(new Error("natpmpClient null"), null);
      return;
    }
    this.natpmpClient().portMapping({ type: protocol, private: localPort, public: externalPort, ttl: natpmpTimeout }, (err, info) => {
      if (err == null) {
        this.refreshTimers[localPort + ":" + externalPort] = setTimeout(() => {
          this.addPortMappingNATPMP(protocol, localPort, externalPort, description, () => {
          });
        }, natpmpTimeout / 2 * 1000);
      }
      callback(err, info);
    });
  }

  removePortMappingNATPMP(protocol, localPort, externalPort, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };
    let timer = this.refreshTimers[localPort + ":" + externalPort];
    if (this.natpmpClient() == null) {
      callback(new Error("natpmpClient null"), null);
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    this.natpmpClient().portUnmapping({ type: protocol, private: localPort, public: externalPort, ttl: 0 }, (err, info) => {
      if (err) {
        log.error("UPNP.removePortMappingNATPMP", err);
      }
      callback(err, info);
    });
  }

  removePortMapping(protocol, localPort, externalPort, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { }
    this.getCapability(() => {
      try {
        if (this.upnpEnabled == true) {
          return this.removePortMappingUPNP(protocol, localPort, externalPort, callback);
        } else if (this.natpmpEnabled == true) {
          return this.removePortMappingNATPMP(protocol, localPort, externalPort, callback);
        } else {
          if (typeof callback === 'function') {
            callback(new Error("no upnp/natpmp"));
          }
        }
      } catch (e) {
        log.error("UPNP.removePortMapping Exception", e);
      }
    });
  }

  removePortMappingUPNP(protocol, localPort, externalPort, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };

    upnpClient.portUnmapping({
      protocol: protocol,
      private: { host: sysManager.myDefaultWanIp(), port: localPort },
      public: externalPort
    }, (err) => {
      if (err) {
        log.error(`UPNP Failed to remove port mapping [${protocol}, ${localPort}, ${externalPort}]: ` + err);
        if (callback) {
          callback(err);
        }
        return;
      }

      upnpMappings = _.reject(upnpMappings, (m) =>
        m.localPort     == localPort &&
        m.externalPort  == externalPort &&
        m.protocol      === protocol
      );

      log.info(util.format("Port mapping [%s, %s, %s] is removed successfully"
        , protocol, localPort, externalPort));

      if (callback) {
        callback();
      }
    });
  }

  getLocalPortMappings(description, callback) {
    callback = callback || function() {};
    upnpClient.getMappings({
      // local: true,
      // description: description
    }, (err, results) => {
      callback(err, results);
    });
  }

  getPortMappingsUPNP(callback) {
    callback = callback || function() {};
    upnpClient.getMappings(callback);
  }

  hasPortMapping(protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function() {};
    upnpClient.getMappings({
      // local: true
      // description: description
    }, (err, results) => {
      if (err) {
        log.error("Failed to get upnp mappings");
        callback(err);
        return;
      }
      log.debug(util.inspect(results));
      let matches = results.find((r) => this.mappingCompare(r, {protocol, localPort, externalPort}));

      log.debug(util.inspect(matches));

      callback(null, !matches.isEmpty)
    });
  }

  getRegisteredUpnpMappings() {
    return upnpMappings;
  }

  mappingCompare(natUpnpMapping, localMapping) {
    // "==" is used instead of "===" with intention here to enable comparison between number and string
    return  natUpnpMapping.public.port   ==  localMapping.externalPort &&
      natUpnpMapping.private.port  ==  localMapping.localPort &&
      natUpnpMapping.protocol      === localMapping.protocol;
  }

  async getExternalIP() {
    return new Promise((resolve, reject) => {
      upnpClient.externalIp((err, ip) => {
        if(err) {
          reject(err);
        } else {
          resolve(ip);
        }
      })
    });
  }
}

