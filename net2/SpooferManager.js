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
'use strict'

let firewalla = require('./Firewalla.js');

let BitBridge = require('../extension/bitbridge/bitbridge.js')

var spawn = require('child_process').spawn;

let spawnProcess = null;

let spoofLogFile = firewalla.getLogFolder() + "/spoof.log";

let SysManager = require("./SysManager.js");
let sysManager = new SysManager();

let Promise = require('bluebird');

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const iptool = require('ip')

const rclient = require('../util/redis_manager.js').getRedisClient()

let log = require("./logger.js")(__filename, 'info');

let fs = require('fs');

let cp = require('child_process');

let monitoredKey = "monitored_hosts";
let unmonitoredKey = "unmonitored_hosts";
let monitoredKey6 = "monitored_hosts6";
let unmonitoredKey6 = "unmonitored_hosts6";

let HostTool = require('../net2/HostTool')
let hostTool = new HostTool();

let exec = require('child-process-promise').exec

let spoofStarted = false;

// WORKAROUND VERSION HERE, will move to a better place
function startSpoofing() {

  if(spoofStarted) {
    return Promise.resolve();
  }
  
  log.info("start spoofing")

  return async(() => {
    await (this.emptySpoofSet())
    
    let ifName = sysManager.monitoringInterface().name;
    let routerIP = sysManager.myGateway();
    let myIP = sysManager.myIp();
    let gateway6 = sysManager.myGateway6();
    
    if(!ifName || !myIP || !routerIP) {
      return Promise.reject("require valid interface name, ip address and gateway ip address");
    }
    
    let b7 = new BitBridge(ifName, routerIP, myIP,null,null,gateway6)
    b7.start()
    
    spoofStarted = true;
    return Promise.resolve();
  })()
  
}

function stopSpoofing() {
  return new Promise((resolve, reject) => {
    spoofStarted = false;
    
    let ifName = sysManager.monitoringInterface().name;
    let routerIP = sysManager.myGateway();
    let myIP = sysManager.myIp();

    if(!ifName || !myIP || !routerIP) {
      return Promise.reject("require valid interface name, ip address and gateway ip address");
    }
    
    let b7 = new BitBridge(ifName, routerIP, myIP)
    b7.stop()
      .then(() => {
        resolve()
      })
  }).catch((err) => {
    //catch everything here
    log.error("Failed to stop spoofing:", err, {})
  })
}

function directSpoof(ip) {
  return async(() => {
    if(iptool.isV4Format(ip)) {
      await (rclient.saddAsync(monitoredKey, ip))      
    } else if(iptool.isV6Format(ip)) {
      await (rclient.saddAsync(monitoredKey6, ip))
    } else {
      return Promise.reject(new Error("Invalid ip address: " + ip))
    }
  })()
}

function emptySpoofSet() {
  return async(() => {
    // clean up redis key
    await (rclient.delAsync(monitoredKey))
    await (rclient.delAsync(unmonitoredKey))
    await (rclient.delAsync(monitoredKey6))
    await (rclient.delAsync(unmonitoredKey6))    
  })()
}

function loadManualSpoof(mac) {
  return async(() => {
    let key = hostTool.getMacKey(mac)
    let host = await (rclient.hgetallAsync(key))
    let manualSpoof = (host.manualSpoof === '1' ? true : false)
    if(manualSpoof) {
      await (rclient.saddAsync(monitoredKey, host.ipv4Addr))
      await (rclient.sremAsync(unmonitoredKey, host.ipv4Addr))
    } else {
      await (rclient.sremAsync(monitoredKey, host.ipv4Addr))
      await (rclient.saddAsync(unmonitoredKey, host.ipv4Addr))
    }    
  })()
}

function loadManualSpoofs(hostManager) {
  log.info("Reloading manual spoof configurations...")
  let activeMACs = hostManager.getActiveMACs()

  return async(() => {
    await (emptySpoofSet()) // this is to ensure no other ip addresses are added to the list    
    activeMACs.forEach((mac) => {
      await (this.loadManualSpoof(mac))
    })
  })()
}


function isSpoofRunning() {
  return async(() => {
    try {
      await (exec("pgrep -x bitbridge7"))

      // TODO: add ipv6 check in the future
    } catch(err) {      
      // error means no bitbridge7 is available
      log.warn("service bitbridge7 is not running (yet)")
      return false
    }
    return true
  })()
}

// TODO support ipv6
function isSpoof(ip) {
  return async(() => {

    try {
      await (exec("pgrep -x bitbridge7"))

      // TODO: add ipv6 check in the future
    } catch(err) {      
      // error means no bitbridge7 is available
      log.warn("service bitbridge7 is not running (yet)")
      return false
    }
    
    // BitBridge.getInstance() is not available for other nodejs processes than FireMain
    /*    
    let instance = BitBridge.getInstance()
    if(!instance) {
      return false
    }

    let started = instance.started
    if(!started) {
      return false
    }
    */
    
    return await (rclient.sismemberAsync(monitoredKey, ip)) == 1
  })()
}

module.exports = {
  startSpoofing: startSpoofing,
  stopSpoofing: stopSpoofing,
  directSpoof:directSpoof,
  isSpoofRunning:isSpoofRunning,
  loadManualSpoofs: loadManualSpoofs,
  loadManualSpoof: loadManualSpoof,
  isSpoof: isSpoof,
  emptySpoofSet: emptySpoofSet
}
