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
let log = require("./logger.js")(__filename);
let fConfig = require('./config.js').getConfig();

let secondaryInterface = require("./SecondaryInterface.js");

let Mode = require('./Mode.js');

let SysManager = require('./SysManager.js');
let sysManager = new SysManager('info');

let Promise = require('bluebird');

let util = require('util');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ();

let curMode = null;

let redis = require('redis');
let rclient = redis.createClient();

function _enforceSpoofMode() {
  if(fConfig.newSpoof) {
    let sm = require('./SpooferManager.js')
    return sm.startSpoofing()
      .then(() => {
        log.info("New Spoof is started");
      }).catch((err) => {
        log.error("Failed to start new spoof", err, {});
      });
  } else {
    // old style, might not work
    var Spoofer = require('./Spoofer.js');
    let spoofer = new Spoofer(config.monitoringInterface,{},true,true);

    return Promise.resolve();
  }
}

function _disableSpoofMode() {
  if(fConfig.newSpoof) {
    let sm = require('./SpooferManager.js')
    log.info("Stopping spoofing");
    return sm.stopSpoofing()
  } else {
    // old style, might not work
    var Spoofer = require('./Spoofer.js');
    let spoofer = new Spoofer(config.monitoringInterface,{},true,true);
    return Promise.all([
      spoofer.clean(),
      spoofer.clean7()
    ]);
  }
}

function _enableSecondaryInterface() {
  return new Promise((resolve, reject) => {  
    secondaryInterface.create(fConfig,(err,ip,subnet,ipnet,mask)=>{
      if (err == null) {
        log.info("Successfully created secondary interface");

        // register the secondary interface info to sysManager
        sysManager.secondaryIp = ip;
        sysManager.secondarySubnet = subnet; 
        sysManager.secondaryIpnet = ipnet; 
        sysManager.secondaryMask  = mask;

        resolve();
      } else {
        log.error("Failed to create secondary interface: " + err);
        reject(err);
      }
    });
  });
}

function _enforceDHCPMode() {
  return dnsmasq.enableDHCP();
}

function _disableDHCPMode() {
  return dnsmasq.disableDHCP();
}

function apply() {
  return Mode.getSetupMode()
    .then((mode) => {
      curMode = mode;
      
      switch(mode) {
      case "dhcp":
        return _enableSecondaryInterface()
          .then(() => {
            return _enforceDHCPMode();
          });
        break;
      case "spoof":
        return _enforceSpoofMode();
        break;
      default:
        // not supported
        return Promise.reject(util.format("mode %s is not supported", mode));
        break;
      }
    });
}

function switchToDHCP() {
  return Mode.dhcpModeOn()
    .then(() => {
      return _disableSpoofMode()
        .then(() => {
        return apply();
        });
    });
}

function switchToSpoof() {
  return Mode.spoofModeOn()
    .then(() => {
      return _disableDHCPMode()
        .then(() => {
          return apply();
        });
    });
}

function reapply() {
  Mode.reloadSetupMode()
    .then((mode) => {
      switch(mode) {
      case "spoof":
        return switchToSpoof();
        break;
      case "dhcp":
        return switchToDHCP();
        break;
      default:
        // not supported
        return Promise.reject(util.format("mode %s is not supported", mode));
        break;
      }
    });
}

function mode() {
  return Mode.reloadSetupMode();
}

// listen on mode change, if anyone update mode in redis, re-apply it
function listenOnChange() {
  rclient.on("message", (channel, message) => {
    if(channel === "Mode:Change") {
      if(curMode !== message) {
        log.info("Mode is changed to " + message);                
        // mode is changed
        reapply();
      }
    }
  });
  rclient.subscribe("Mode:Change");
}

// this function can only used by non-main.js process
// it is used to notify main.js that mode has been changed
function publish(mode) {
  rclient.publish("Mode:Change", mode);
}

function setSpoofAndPublish() {
  Mode.spoofModeOn()
    .then(() => {
      publish("spoof");
    });
}

function setDHCPAndPublish() {
  Mode.dhcpModeOn()
    .then(() => {
      publish("dhcp");
    });
}

module.exports = {
  apply:apply,
  switchToDHCP:switchToDHCP,
  switchToSpoof:switchToSpoof,
  mode: mode,
  listenOnChange: listenOnChange,
  publish: publish,
  setDHCPAndPublish: setDHCPAndPublish,
  setSpoofAndPublish: setSpoofAndPublish,
  enableSecondaryInterface:_enableSecondaryInterface
}
