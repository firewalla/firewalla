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

const firewalla = require('./Firewalla.js')

const async = require('asyncawait/async')
const await = require('asyncawait/await')

let util = require('util');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let curMode = null;

let redis = require('redis');
let rclient = redis.createClient();

Promise.promisifyAll(redis.RedisClient.prototype);

const AUTO_REVERT_INTERVAL = 240 * 1000 // 4 minutes

let timer = null

function _revert2None() {
  return async(() => {
    timer = null
    let bootingComplete = await (firewalla.isBootingComplete())
    let firstBindDone = await (firewalla.isFirstBindDone())
    if(!bootingComplete && firstBindDone) {
      log.info("Revert back to none mode for safety")
      return switchToNone()
    }
  })()
}

function _enforceSpoofMode() {
  return async(() => {
    let bootingComplete = await (firewalla.isBootingComplete())
    let firstBindDone = await (firewalla.isFirstBindDone())
    
    if(!bootingComplete && firstBindDone) {
      if(timer) {
        clearTimeout(timer)
        timer = null
      }
      // init stage, reset to none after X seconds if booting not complete
      timer = setTimeout(_revert2None, AUTO_REVERT_INTERVAL)
    }
    
    if(fConfig.newSpoof) {
      let sm = require('./SpooferManager.js')
      await (sm.startSpoofing())
      log.info("New Spoof is started");
    } else {
      // old style, might not work
      const Spoofer = require('./Spoofer.js');
      const spoofer = new Spoofer(config.monitoringInterface,{},true,true);
      return Promise.resolve();
    }
  })().catch((err) => {
    log.error("Failed to start new spoof", err, {});
  });
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
  sem.emitEvent({
    type: 'StartDHCP',
    message: "Enabling DHCP Mode"
  });
  return Promise.resolve();
}

function _disableDHCPMode() {
  sem.emitEvent({
    type: 'StopDHCP',
    message: "Disabling DHCP Mode"
  });
  return Promise.resolve();
}

function apply() {
  return async(() => {
    let mode = await (Mode.getSetupMode())

    curMode = mode;
    
    log.info("Applying mode", mode, "...", {})

    let HostManager = require('./HostManager.js')
    let hostManager = new HostManager('cli', 'server', 'info')
    
    switch(mode) {
    case Mode.MODE_DHCP:
      await (_enableSecondaryInterface())
      await (_enforceDHCPMode())
      break;
    case Mode.MODE_AUTO_SPOOF:
      await (_enforceSpoofMode())

      // reset oper history for each device, so that we can re-apply spoof commands
      hostManager.cleanHostOperationHistory()

      await (hostManager.getHostsAsync())
      break;
    case Mode.MODE_MANUAL_SPOOF:
      await (_enforceSpoofMode())
      let sm = require('./SpooferManager.js')
      await (hostManager.getHostsAsync())
      await (sm.loadManualSpoofs(hostManager)) // populate monitored_hosts based on manual Spoof configs
      break;
    case Mode.MODE_NONE:
      // no thing
      break;
    default:
      // not supported
      return Promise.reject(util.format("mode %s is not supported", mode));
      break;
    }
  })()
}

function switchToDHCP() {
  log.info("Switching to DHCP")
  
  return Mode.dhcpModeOn()
    .then(() => {
      return _disableSpoofMode()
        .then(() => {
          return apply();
        });
    });
}

function switchToSpoof() {
  log.info("Switching to legacy spoof")
  return switchToAutoSpoof()
}

function switchToAutoSpoof() {
  log.info("Switching to auto spoof")
  return Mode.autoSpoofModeOn()
    .then(() => {
      return _disableDHCPMode()
        .then(() => {
          return apply();
        });
    });
}

function switchToManualSpoof() {
  log.info("Switching to manual spoof")
  return Mode.manualSpoofModeOn()
    .then(() => {
      return _disableDHCPMode()
        .then(() => {
          return apply();
        });
    });  
}

function switchToNone() {
  log.info("Switching to none")
  return async(() => {
    await (Mode.noneModeOn())
    await (_disableDHCPMode())
    await (_disableSpoofMode())
    return apply()
  })()
}

function reapply() {
  return async(() => {
    let lastMode = await (Mode.getSetupMode())
    log.info("Old mode is", lastMode)

    switch(lastMode) {
    case "spoof":
    case "autoSpoof":
    case "manualSpoof":
      _disableSpoofMode()
      break;
    case "dhcp":
      _disableDHCPMode()
      break;
    case "none":
      // do nothing
      break;
    default:
      break;
    }
    
    await (Mode.reloadSetupMode())
    return apply()
  })()
  
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
    } else if (channel === "ManualSpoof:Update") {
      let HostManager = require('./HostManager.js')
      let hostManager = new HostManager('cli', 'server', 'info')
      let sm = require('./SpooferManager.js')
      sm.loadManualSpoofs(hostManager)
    }
  });
  rclient.subscribe("Mode:Change");
  rclient.subscribe("ManualSpoof:Update");
}

// this function can only used by non-main.js process
// it is used to notify main.js that mode has been changed
function publish(mode) {
  return rclient.publishAsync("Mode:Change", mode);
}

function publishManualSpoofUpdate() {
  return rclient.publishAsync("ManualSpoof:Update", "1")
}

function setSpoofAndPublish() {
  setAutoSpoofAndPublish()
}

function setAutoSpoofAndPublish() { 
  Mode.autoSpoofModeOn()
    .then(() => {
      publish(Mode.MODE_AUTO_SPOOF);
    });
}

function setManualSpoofAndPublish() { 
  Mode.manualSpoofModeOn()
    .then(() => {
      publish(Mode.MODE_MANUAL_SPOOF);
    });
}

function setDHCPAndPublish() {
  Mode.dhcpModeOn()
    .then(() => {
      publish(Mode.MODE_DHCP);
    });
}

function setNoneAndPublish() {
  async(() => {
    await (Mode.noneModeOn())
    await (publish(Mode.MODE_NONE))
  })()
}

module.exports = {
  apply:apply,
  switchToDHCP:switchToDHCP,
  switchToSpoof:switchToSpoof,
  switchToManualSpoof: switchToManualSpoof,
  switchToAutoSpoof: switchToAutoSpoof,
  switchToNone: switchToNone,
  mode: mode,
  listenOnChange: listenOnChange,
  publish: publish,
  setDHCPAndPublish: setDHCPAndPublish,
  setSpoofAndPublish: setSpoofAndPublish,
  setAutoSpoofAndPublish: setAutoSpoofAndPublish,
  setManualSpoofAndPublish: setManualSpoofAndPublish,
  setNoneAndPublish: setNoneAndPublish,
  publishManualSpoofUpdate: publishManualSpoofUpdate,
  enableSecondaryInterface:_enableSecondaryInterface
}
