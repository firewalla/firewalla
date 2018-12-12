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
const log = require("./logger.js")(__filename);
const Config = require('./config.js');
let fConfig = Config.getConfig();

let secondaryInterface = require("./SecondaryInterface.js");

let Mode = require('./Mode.js');

let SysManager = require('./SysManager.js');
let sysManager = new SysManager('info');

const Discovery = require('./Discovery.js');
const d = new Discovery("modeManager", fConfig, "info", false);

const iptables = require('./Iptables.js');

let Promise = require('bluebird');

const firewalla = require('./Firewalla.js')

const async = require('asyncawait/async')
const await = require('asyncawait/await')

let util = require('util');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let curMode = null;

const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const cp = require('child_process');
const execAsync = util.promisify(cp.exec);

const fs = require('fs');
const writeFileAsync = Promise.promisify(fs.writeFile);
const readFileAsync = Promise.promisify(fs.readFile);


const AUTO_REVERT_INTERVAL = 600 * 1000 // 10 minutes

let timer = null

function _revert2None() {
  return async(() => {
    timer = null
    let bootingComplete = await (firewalla.isBootingComplete())
    let firstBindDone = await (firewalla.isFirstBindDone())
    if(!bootingComplete && firstBindDone) {
      log.warn("Revert back to none mode for safety")
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

async function _changeToAlternativeIpSubnet() {
  fConfig = Config.getConfig(true);
  // backward compatibility if alternativeIpSubnet is not set
  if (!fConfig.alternativeIpSubnet)
    return;
  const altIpSubnet = fConfig.alternativeIpSubnet.ipsubnet;
  const altGateway = fConfig.alternativeIpSubnet.gateway;
  const secondaryIpSubnet = sysManager.mySubnet2();
  const oldGateway = sysManager.myGateway();
  const oldIpSubnet = sysManager.mySubnet();
  let cmd = "";
  
  if (oldIpSubnet !== altIpSubnet) {
    // save ip address of simple mode, and delete it from eth0
    const simpleIpFile = firewalla.getHiddenFolder() + "/run/simple_ip";
    if (fs.existsSync(simpleIpFile)) {
      // simple_ip file already exists. This is likely an update of alternative ip/subnet and should not override simple_ip file
      log.info("simple_ip file already exists. No need to override it.");
    } else {
      await writeFileAsync(simpleIpFile, oldIpSubnet);
    }
    // add new ip subnet before deleting old one
    cmd = util.format("sudo /sbin/ip addr replace %s dev eth0", altIpSubnet);
    log.info("Command to add new ip assignment: " + cmd);
    await execAsync(cmd);
    const altIp = altIpSubnet.split('/')[0];
    // dns change is done in dnsmasq.js
    // await iptables.dnsChangeAsync(altIpSubnet, altIp + ":8853", true); // add new dns DNAT rule
    // await iptables.dnsChangeAsync(secondaryIpSubnet, altIp + ":8853", true); // add new dns DNAT rule for dhcp subnet
    await iptables.diagHttpChangeAsync(altIp, true); // add new diag http redirect rule
    const savedIpFile = firewalla.getHiddenFolder() + "/run/saved_ip";
    await writeFileAsync(savedIpFile, altIpSubnet);

    try {
      cmd = util.format("sudo /sbin/ip addr del %s dev eth0", oldIpSubnet);
      log.info("Command to remove old ip assignment: " + cmd);
      await execAsync(cmd);
      const oldIp = oldIpSubnet.split('/')[0];
      // dns change is done in dnsmasq.js
      // await iptables.dnsChangeAsync(oldIpSubnet, oldIp + ":8853", false); // remove old dns DNAT rule
      // await iptables.dnsChangeAsync(secondaryIpSubnet, oldIp + ":8853", false); // remove old dns DNAT rule for dhcp subnet
      await iptables.diagHttpChangeAsync(oldIp, false); // remove old diag http redirect rule
    } catch (err) {
      log.warn(util.format("Old ip subnet %s is not found on eth0.", oldIpSubnet));
    }
  }

  if (oldGateway !== altGateway) {
    // save gateway of simple mode, and delete it from routing table
    const simpleGwFile = firewalla.getHiddenFolder() + "/run/simple_gw";
    if (fs.existsSync(simpleGwFile)) {
      // simple_gw file already exists. This is likely an update of alternative ip/subnet and should not override simple_gw file
      log.info("simple_gw file already exists. No need to override it.");
    } else {
      await writeFileAsync(simpleGwFile, oldGateway);
    }
    cmd = util.format("sudo /sbin/ip route replace default via %s dev eth0", altGateway);
    log.info("Command to update gateway assignment: " + cmd);
    await execAsync(cmd);
    const savedGwFile = firewalla.getHiddenFolder() + "/run/saved_gw";
    await writeFileAsync(savedGwFile, altGateway);

    // save dns of simple mode, and update it
    const simpleResolvFile = firewalla.getHiddenFolder() + "/run/simple_resolv.conf";
    if (fs.existsSync(simpleResolvFile)) {
      // simple_resolv.conf already exists. This is likely an update of alternative dns and should not override simple_resolv.conf file
      log.info("simple_resolv.conf file already exists. No need to override it.");
    } else {
      cmd = util.format("cp /etc/resolv.conf %s", simpleResolvFile);
      await execAsync(cmd);
    }
    cmd = util.format("sudo sed -i s/%s/%s/g /etc/resolv.conf", oldGateway, altGateway);
    log.info("Command to update resolv.conf: " + cmd);
    await execAsync(cmd);
    const savedResolvFile = firewalla.getHiddenFolder() + "/run/saved_resolv.conf";
    cmd = util.format("sudo /bin/cp -f /etc/resolv.conf %s", savedResolvFile);
    await execAsync(cmd);
  }

  return new Promise((resolve, reject) => {
    // rescan all interfaces to reflect network changes
    d.discoverInterfaces(() => {
      sysManager.update(() => {
        pclient.publishAsync("System:IPChange", "");
        resolve();
      });
    });
  });
}

function _enableSecondaryInterface() {
  return new Promise((resolve, reject) => {  
    fConfig = Config.getConfig(true);
    secondaryInterface.create(fConfig,(err,ip,subnet,ipnet,mask, legacyIp, legacySubnet)=>{
      if (err == null) {
        log.info("Successfully created secondary interface");
        d.discoverInterfaces(() => {
          sysManager.update(() => {
            // secondary interface ip changed, reload sysManager in all Fire* processes
            pclient.publishAsync("System:IPChange", "");
            // register the secondary interface info to sysManager
            sysManager.secondaryIp = ip;
            sysManager.secondarySubnet = subnet;
            sysManager.secondaryIpnet = ipnet;
            sysManager.secondaryMask = mask;
            if (legacySubnet) {
              (async () => {
                if (legacySubnet) {
                  // legacySubnet and subnet should be like 192.168.218.0/24
                  const fwIp = sysManager.myIp();
                  // dns change is done in dnsmasq.js
                  // await iptables.dnsChangeAsync(legacySubnet, fwIp, false); // remove old dns DNAT rule
                  await iptables.dhcpSubnetChangeAsync(legacySubnet, false); // remove old DHCP MASQUERADE rule
                  if (legacyIp) { // legacyIp should be exact address like 192.168.218.1
                    await iptables.diagHttpChangeAsync(legacyIp, false);
                  }
                }
                // dns change is done in dnsmasq.js
                // await iptables.dnsChangeAsync(subnet, fwIp, true); // add new dns DNAT rule
                await iptables.dhcpSubnetChangeAsync(subnet, true); // add new DHCP MASQUERADE rule
                const newIpAddr = ip.split('/')[0]; // newIpAddr should be like 192.168.220.1
                if (newIpAddr) {
                  await iptables.diagHttpChangeAsync(newIpAddr, true);
                }
                resolve();
              })().catch((err) => {
                log.error("Failed to update nat for legacy IP subnet: " + legacySubnet, err);
                reject(err);
              });
            } else {
              resolve();
            }
          });
        });
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
      await (_changeToAlternativeIpSubnet())
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
  sclient.on("message", (channel, message) => {
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
  sclient.subscribe("Mode:Change");
  sclient.subscribe("ManualSpoof:Update");
}

// this function can only used by non-main.js process
// it is used to notify main.js that mode has been changed
function publish(mode) {
  return pclient.publishAsync("Mode:Change", mode);
}

function publishManualSpoofUpdate() {
  return pclient.publishAsync("ManualSpoof:Update", "1")
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
