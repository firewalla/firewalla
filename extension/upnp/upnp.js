/*    Copyright 2017 - 2020 Firewalla Inc
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
const natpmpTimeout = 86400;

const Message = require('../../net2/Message.js');
const f = require('../../net2/Firewalla.js');
const ip = require('ip');
const mode = require('../../net2/Mode.js');

const sem = require('../../sensor/SensorEventManager.js').getInstance();

let registeredUpnpMappings = [];
const upnpCheckInterval = 15 * 60 * 1000 // 15 mins

module.exports = class {
  constructor() {
    if (instance == null) {
      // WAN UPnP/NATPMP client is used to add/remove mappings
      this.wanUpnpClient = null;
      this.wanNatPmpClient = null;

      // monitorUpnpClients are used to query mappings, i.e. read-only
      this.monitoredUpnpClients = [];

      instance = this;
      this.refreshTimers = {};

      if (f.isMain()) {
        this.scheduleReload();
        this.upnpIntervalHandler = setInterval(
          async () => {
            log.info("UPnP periodical check starts")
            if (registeredUpnpMappings.isEmpty) {
              log.info("No mapping registered.")
              return;
            }
            const results = await this.getPortMappingsUPNP().catch((err) => {
              log.error("Failed to get current mappings", err);
              return null;
            });
            if (results) {
              log.info("Current mappings: ", results);
              registeredUpnpMappings.forEach((check) => {
                log.info("Checking registered mapping:", check);
                if (_.isEmpty(
                  results.find((m) => this.mappingCompare(m, check))
                )) {
                  log.info("Mapping no longer exists, adding back to router...")
                  let { protocol, localPort, externalPort, description } = check;
                  if (this.wanUpnpClient)
                    this.addPortMappingUPNP(this.wanUpnpClient, protocol, localPort, externalPort, description);
                } else {
                  log.info("Mapping still exists")
                }
              })
            }
          },
          upnpCheckInterval
        );

        sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
          log.info("Schedule reload upnp clients since network info is reloaded");
          this.scheduleReload();
        })
      }
    }
    return instance;
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(async () => {
      if (this.wanNatPmpClient)
        this.wanNatPmpClient.close();
      this.wanNatPmpClient = null;
      if (this.wanUpnpClient)
        this.wanUpnpClient.close();
      this.wanUpnpClient = null;
      for (const c of this.monitoredUpnpClients) {
        c.close();
      }
      this.monitoredUpnpClients = [];
      registeredUpnpMappings = [];
      // check availability of UPnP
      const defaultWanIp = sysManager.myDefaultWanIp();
      if (defaultWanIp && ip.isPrivate(defaultWanIp) && !(await mode.isRouterModeOn())) {
        const wanUpnpClient = natupnp.createClient({listenAddr: defaultWanIp});
        wanUpnpClient.externalIp((err, ip) => {
          if (err || ip == null) {
            log.info(`UPnP write client may not work on WAN ${defaultWanIp}`);
          }
        });
        this.wanUpnpClient = wanUpnpClient;
      }
      // check availability of NATPMP
      const defaultGateway = sysManager.myDefaultGateway();
      if (defaultGateway && ip.isPrivate(defaultWanIp) && !(await mode.isRouterModeOn())) {
        const wanNatPmpClient = natpmp.connect(defaultGateway, defaultWanIp);
        wanNatPmpClient.on('error', (err) => {
          log.error(`NATPMP write clien does not work on gw ${defaultGateway}`, err);
          wanNatPmpClient.close();
          this.wanNatPmpClient = null;
        });
        if (wanNatPmpClient) {
          wanNatPmpClient.externalIp((err, info) => {
            if (err || info == null) {
              log.info(`NATPMP write client may not work on gw ${defaultGateway}`);
            }
          });
          this.wanNatPmpClient = wanNatPmpClient;
        }
      }

      // initalize read-only upnp clients
      const monitoringInterfaces = sysManager.getMonitoringInterfaces();
      for (const iface of monitoringInterfaces) {
        if (iface.name.endsWith(":0"))
          continue;
        if (!iface.ip_address)
          continue;
        const upnpClient = natupnp.createClient({listenAddr: iface.ip_address});
        upnpClient.externalIp((err, ip) => {
          if (err || ip == null) {
            log.info(`UPnP monitor client may not work on ${iface.ip_address}`);
          }
          this.monitoredUpnpClients.push(upnpClient);
        });
      }
      
    }, 5000);
  }

  addPortMapping(protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function() { };

    try {
      if (this.wanUpnpClient) {
        return this.addPortMappingUPNP(this.wanUpnpClient, protocol, localPort, externalPort, description, callback);
      }
      if (this.wanNatPmpClient) {
        return this.addPortMappingNATPMP(this.wanNatPmpClient, protocol, localPort, externalPort, description, callback);
      }
      log.warn("Neither UPnP nor NATPMP write client works");
      callback(null);
    } catch (err) {
      log.error("Failed to add port mapping", err);
      callback(err);
    }
  }

  addPortMappingUPNP(client, protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };

    client.portMapping({
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
      if (_.isEmpty(registeredUpnpMappings.find((m) =>
        m.localPort     == localPort &&
        m.externalPort  == externalPort &&
        m.protocol      === protocol
      ))) {
        registeredUpnpMappings.push(mappingObj);
      } else {
        log.info("Mapping handler already exists");
      }

      callback();
    });
  }

  addPortMappingNATPMP(client, protocol, localPort, externalPort, description, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };
   
    client.portMapping({ type: protocol, private: localPort, public: externalPort, ttl: natpmpTimeout }, (err, info) => {
      if (err == null) {
        this.refreshTimers[localPort + ":" + externalPort] = setTimeout(() => {
          this.addPortMappingNATPMP(protocol, localPort, externalPort, description, () => {
          });
        }, natpmpTimeout / 2 * 1000);
      }
      callback(err, info);
    });
  }

  removePortMappingNATPMP(client, protocol, localPort, externalPort, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };
    let timer = this.refreshTimers[localPort + ":" + externalPort];
    if (timer) {
      clearTimeout(timer);
    }
    client.portUnmapping({ type: protocol, private: localPort, public: externalPort, ttl: 0 }, (err, info) => {
      if (err) {
        log.error("UPNP.removePortMappingNATPMP", err);
      }
      callback(err, info);
    });
  }

  removePortMapping(protocol, localPort, externalPort, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };

    try {
      if (this.wanUpnpClient) {
        return this.removePortMappingUPNP(this.wanUpnpClient, protocol, localPort, externalPort, callback);
      }
      if (this.wanNatPmpClient) {
        return this.removePortMappingNATPMP(this.wanNatPmpClient, protocol, localPort, externalPort, callback);
      }
      log.warn("Neither UPnP nor NATPMP write client works");
      callback(null);
    } catch (err) {
      log.error("Failed to remove port mapping", err);
      callback(err);
    }
  }

  removePortMappingUPNP(client, protocol, localPort, externalPort, callback) {
    protocol = protocol.toLowerCase()
    callback = callback || function () { };

    client.portUnmapping({
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

      registeredUpnpMappings = _.reject(registeredUpnpMappings, (m) =>
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
    this.getPortMappingsUPNP().then((result) => {
      callback(null, result)
    }).catch((err) => {
      callback(err, null);
    });
  }

  async getPortMappingsUPNP() {
    let results = [];
    for (const c of this.monitoredUpnpClients) {
      const getMappingsAsync = util.promisify(c.getMappings).bind(c);
      const mappings = await getMappingsAsync().catch((err) => []);
      results = results.concat(mappings);
    }
    return results;
  }

  getRegisteredUpnpMappings() {
    return registeredUpnpMappings;
  }

  mappingCompare(natUpnpMapping, localMapping) {
    // "==" is used instead of "===" with intention here to enable comparison between number and string
    return  natUpnpMapping.public.port   ==  localMapping.externalPort &&
      natUpnpMapping.private.port  ==  localMapping.localPort &&
      natUpnpMapping.protocol      === localMapping.protocol;
  }

  async getExternalIP() {
    return new Promise((resolve, reject) => {
      if (this.wanUpnpClient) {
        this.wanUpnpClient.externalIp((err, ip) => {
          if(err) {
            reject(err);
          } else {
            resolve(ip);
          }
        })
      } else {
        resolve(null);
      }
    });
  }
}

