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

const SpooferManager = require('./SpooferManager.js');

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

const HostTool = require('./HostTool.js');
const hostTool = new HostTool();

const cp = require('child_process');
const execAsync = util.promisify(cp.exec);

const fs = require('fs');
const writeFileAsync = Promise.promisify(fs.writeFile);
const readFileAsync = Promise.promisify(fs.readFile);
const unlinkAsync = Promise.promisify(fs.unlink);


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
      let sm = new SpooferManager();
      sm.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway(), sysManager.myIp(), false);
      // register v6 spoof instance if v6 gateway is assigned
      if (sysManager.myGateway6()) { // empty string also returns false
        sm.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway6(), sysManager.myIp6()[0], true);
        if (sysManager.myDNS() && sysManager.myDNS().includes(sysManager.myGateway())) {
          // v4 dns includes gateway ip, very likely gateway's v6 addresses are dns servers, need to spoof these addresses (no matter public or linklocal)
          const gateway = await (hostTool.getMacEntryByIP(sysManager.myGateway()));
          if (gateway.ipv6Addr) {
            const gatewayIpv6Addrs = JSON.parse(gateway.ipv6Addr);
            log.info("Router also acts as dns, spoof all router's v6 addresses: ", gatewayIpv6Addrs);
            for (let i in gatewayIpv6Addrs) {
              const addr = gatewayIpv6Addrs[i];
              sm.registerSpoofInstance(sysManager.monitoringInterface().name, addr, sysManager.myIp6(), true);
            }
          }
        }
      }
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
    let sm = new SpooferManager();
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

// for ipv4 only
async function _saveSimpleModeNetworkSettings() {
  const ipSubnet = sysManager.mySubnet();
  const gateway = sysManager.myGateway();
  const simpleIpFile = firewalla.getHiddenFolder() + "/run/simple_ip";
  let cmd = "";
  if (fs.existsSync(simpleIpFile)) {
    // simple_ip file already exists. This is likely an update of alternative ip/subnet and should not override simple_ip file
    log.info("simple_ip file already exists. No need to override it.");
  } else {
    await writeFileAsync(simpleIpFile, ipSubnet);
  }

  const simpleGwFile = firewalla.getHiddenFolder() + "/run/simple_gw";
  if (fs.existsSync(simpleGwFile)) {
    // simple_gw file already exists. This is likely an update of alternative gateway and should not override simple_gw file
    log.info("simple_gw file already exists. No need to override it.");
  } else {
    await writeFileAsync(simpleGwFile, gateway);
  }

  const simpleResolvFile = firewalla.getHiddenFolder() + "/run/simple_resolv.conf";
  if (fs.existsSync(simpleResolvFile)) {
    // simple_resolv.conf already exists. This is likely an update of alternative dns and should not override simple_resolv.conf file
    log.info("simple_resolv.conf file already exists. No need to override it.");
  } else {
    cmd = util.format("cp /etc/resolv.conf %s", simpleResolvFile);
    await execAsync(cmd);
  }
}

// for ipv4 only
async function _restoreSimpleModeNetworkSettings() {
  const oldIpSubnet = sysManager.myIp();
  let cmd = "";

  const simpleIpFile = firewalla.getHiddenFolder() + "/run/simple_ip";
  if (fs.existsSync(simpleIpFile)) {
    // delete old ip from eth0
    const simpleIpSubnet = await readFileAsync(simpleIpFile, "utf8");
    try {
      cmd = util.format("sudo /sbin/ip addr del %s dev eth0", oldIpSubnet);
      log.info("Command to remove old ip assignment: " + cmd);
      await execAsync(cmd);
      const oldIp = oldIpSubnet.split('/')[0];
      // dns rule change is done in dnsmasq.js
      await iptables.diagHttpChangeAsync(oldIp, false); // remove old diag http redirect rule
    } catch (err) {
      log.warn(util.format("Old ip subnet %s is not found on eth0."), oldIpSubnet);
    }

    cmd = util.format("sudo /sbin/ip addr replace %s dev eth0", simpleIpSubnet);
    log.info("Command to restore simple ip assignment: " + cmd);
    await execAsync(cmd);
    const simpleIp = simpleIpSubnet.split('/')[0];
    // dns rule change is done in dnsmasq.js
    await iptables.diagHttpChangeAsync(simpleIp, true); // add new diag http redirect rule
    await unlinkAsync(simpleIpFile); // remove simple_ip file
    const savedIpFile = firewalla.getHiddenFolder() + "/run/saved_ip";
    cmd = util.format("sudo bash -c 'echo %s > %s'", simpleIpSubnet, savedIpFile);
    await execAsync(cmd);
  } else {
    log.info("simple_ip file is not found. No need to update ip address.");
  }

  const simpleGwFile = firewalla.getHiddenFolder() + "/run/simple_gw";
  if (fs.existsSync(simpleGwFile)) {
    // update default route
    const simpleGateway = await readFileAsync(simpleGwFile, "utf8");
    cmd = util.format("sudo /sbin/ip route replace default via %s dev eth0", simpleGateway);
    log.info("Command to update simple gateway assignment: " + cmd);
    await execAsync(cmd);
    await unlinkAsync(simpleGwFile); // remove simple_gw file
    const savedGwFile = firewalla.getHiddenFolder() + "/run/saved_gw";
    cmd = util.format("sudo bash -c 'echo %s > %s'", simpleGateway, savedGwFile);
    await execAsync(cmd);
  } else {
    log.info("simple_gw file is not found. No need to udpate default route.");
  }

  const simpleResolvFile = firewalla.getHiddenFolder() + "/run/simple_resolv.conf";
  if (fs.existsSync(simpleResolvFile)) {
    cmd = util.format("sudo cp %s /etc/resolv.conf", simpleResolvFile);
    await execAsync(cmd);
    await unlinkAsync(simpleResolvFile); // remove simple_resolv.conf file
  } else {
    log.info("simple_resolv.conf file is not found. No need to update dns.");
  }

  return new Promise((resolve, reject) => {
    // rescan all interfaces to reflect network changes
    d.discoverInterfaces(() => {
      sysManager.update(() => {
        resolve();
      });
    });
  });
}

async function _changeToAlternativeIpSubnet() {
  fConfig = Config.getConfig(true);
  // backward compatibility if alternativeInterface is not set
  if (!fConfig.alternativeInterface)
    return;
  const altIpSubnet = fConfig.alternativeInterface.ip;
  const altGateway = fConfig.alternativeInterface.gateway;
  const oldGateway = sysManager.myGateway();
  const oldIpSubnet = sysManager.mySubnet();
  let cmd = "";
  
  if (oldIpSubnet !== altIpSubnet) {
    // delete old ip from eth0
    try {
      cmd = util.format("sudo /sbin/ip addr del %s dev eth0", oldIpSubnet);
      log.info("Command to remove old ip assignment: " + cmd);
      await execAsync(cmd);
      const oldIp = oldIpSubnet.split('/')[0];
      // dns rule change is done in dnsmasq.js
      await iptables.diagHttpChangeAsync(oldIp, false); // remove old diag http redirect rule
    } catch (err) {
      log.warn(util.format("Old ip subnet %s is not found on eth0.", oldIpSubnet));
    }

    cmd = util.format("sudo /sbin/ip addr replace %s dev eth0", altIpSubnet);
    log.info("Command to add alternative ip assignment: " + cmd);
    await execAsync(cmd);
    const altIp = altIpSubnet.split('/')[0];
    // dns rule change is done in dnsmasq.js
    await iptables.diagHttpChangeAsync(altIp, true); // add new diag http redirect rule
    const savedIpFile = firewalla.getHiddenFolder() + "/run/saved_ip";
    cmd = util.format("sudo bash -c 'echo %s > %s'", altIpSubnet, savedIpFile);
    await execAsync(cmd);
  }

  if (oldGateway !== altGateway) {
    // update default route
    cmd = util.format("sudo /sbin/ip route replace default via %s dev eth0", altGateway);
    log.info("Command to update alternative gateway assignment: " + cmd);
    await execAsync(cmd);
    const savedGwFile = firewalla.getHiddenFolder() + "/run/saved_gw";
    cmd = util.format("sudo bash -c 'echo %s > %s'", altGateway, savedGwFile);
    await execAsync(cmd);

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
        resolve();
      });
    });
  });
}

function _enableSecondaryInterface() {
  return new Promise((resolve, reject) => {  
    fConfig = Config.getConfig(true);
    secondaryInterface.create(fConfig,(err, ipSubnet, legacyIpSubnet)=>{
      if (err == null) {
        log.info("Successfully created secondary interface");
        if (legacyIpSubnet) { // secondary ip is changed
          d.discoverInterfaces(() => {
            sysManager.update(() => {
              // secondary interface ip changed, reload sysManager in all Fire* processes
              (async () => {
                // legacyIpSubnet should be like 192.168.218.0/24
                // dns change is done in dnsmasq.js
                await iptables.dhcpSubnetChangeAsync(legacyIpSubnet, false); // remove old DHCP MASQUERADE rule
                const legacyIp = legacyIpSubnet.split('/')[0];
                // legacyIp should be exact address like 192.168.218.1
                await iptables.diagHttpChangeAsync(legacyIp, false);
                // dns change is done in dnsmasq.js
                await iptables.dhcpSubnetChangeAsync(ipSubnet, true); // add new DHCP MASQUERADE rule
                const ip = ipSubnet.split('/')[0];
                await iptables.diagHttpChangeAsync(ip, true);
                resolve();
              })().catch((err) => {
                log.error("Failed to update nat for legacy IP subnet: " + legacyIpSubnet, err);
                reject(err);
              });
            });
          });
        } else {
          resolve();
        }
      } else {
        log.error("Failed to create secondary interface: " + err);
        reject(err);
      }
    });
  });
}

async function _enforceDHCPMode(mode) {
  mode = mode || "dhcp";
  // need to kill dhclient otherwise ip lease will be relinquished once it is expired, causing system reboot
  const cmd = "pidof dhclient && sudo pkill dhclient; true";
  try {
    await execAsync(cmd);
  } catch (err) {
    log.warn("Failed to kill dhclient");
  }
  sem.emitEvent({
    type: 'StartDHCP',
    mode: mode,
    message: "Enabling DHCP Mode"
  });
  return Promise.resolve();
}

function _disableDHCPMode(mode) {
  mode = mode || "dhcp";
  sem.emitEvent({
    type: 'StopDHCP',
    mode: mode,
    message: "Disabling DHCP Mode"
  });
  return Promise.resolve();
}

async function toggleCompatibleSpoof(state) {
  if (state) {
    let cmd = "sudo iptables -w -t nat -C POSTROUTING -m set --match-set monitored_ip_set src -j MASQUERADE || sudo iptables -w -t nat -A POSTROUTING -m set --match-set monitored_ip_set src -j MASQUERADE";
    await execAsync(cmd);
    cmd = "sudo ip6tables -w -t nat -C POSTROUTING -m set --match-set monitored_ip_set6 src -j MASQUERADE || sudo ip6tables -w -t nat -A POSTROUTING -m set --match-set monitored_ip_set6 src -j MASQUERADE";
    await execAsync(cmd);
  } else {
    let cmd = "(sudo iptables -w -t nat -C POSTROUTING -m set --match-set monitored_ip_set src -j MASQUERADE && sudo iptables -w -t nat -D POSTROUTING -m set --match-set monitored_ip_set src -j MASQUERADE) || true";
    await execAsync(cmd);
    cmd = "(sudo ip6tables -w -t nat -C POSTROUTING -m set --match-set monitored_ip_set6 src -j MASQUERADE && sudo ip6tables -w -t nat -D POSTROUTING -m set --match-set monitored_ip_set6 src -j MASQUERADE) || true";
    await execAsync(cmd);
  }
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
      await (_saveSimpleModeNetworkSettings())
      await (_changeToAlternativeIpSubnet())
      await (_enableSecondaryInterface())
      await (_enforceDHCPMode())
      pclient.publishAsync("System:IPChange", "");
      break;
    case Mode.MODE_DHCP_SPOOF:
    case Mode.MODE_AUTO_SPOOF:
      await (_enableSecondaryInterface()) // secondary interface ip/subnet may be changed
      await (_restoreSimpleModeNetworkSettings())
      await (_enforceSpoofMode())
      pclient.publishAsync("System:IPChange", "");
      // reset oper history for each device, so that we can re-apply spoof commands
      hostManager.cleanHostOperationHistory()

      await (hostManager.getHostsAsync())
      if (mode === Mode.MODE_DHCP_SPOOF) {
        // enhanced spoof is necessary for dhcp spoof
        hostManager.setPolicy("enhancedSpoof", true);
        // dhcp service is needed for dhcp spoof mode
        await (_enforceDHCPMode(mode))
      }
      break;
    case Mode.MODE_MANUAL_SPOOF:
      await (_enforceSpoofMode())
      let sm = new SpooferManager();
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
      await (_disableSpoofMode())
      break;
    case "dhcp":
      await (_disableDHCPMode(lastMode))
      break;
    case "dhcpSpoof":
      await (_disableSpoofMode())
      await (_disableDHCPMode(lastMode))
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
      let sm = new SpooferManager();
      sm.loadManualSpoofs(hostManager)
    } else if (channel === "NetworkInterface:Update") {
      (async () => {
        await (_changeToAlternativeIpSubnet());
        await (_enableSecondaryInterface());
        pclient.publishAsync("System:IPChange", "");
      })()
    }
  });
  sclient.subscribe("Mode:Change");
  sclient.subscribe("ManualSpoof:Update");
  sclient.subscribe("NetworkInterface:Update");
}

// this function can only used by non-main.js process
// it is used to notify main.js that mode has been changed
function publish(mode) {
  return pclient.publishAsync("Mode:Change", mode);
}

function publishManualSpoofUpdate() {
  return pclient.publishAsync("ManualSpoof:Update", "1")
}

function publishNetworkInterfaceUpdate() {
  return pclient.publishAsync("NetworkInterface:Update", "");
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

function setDHCPSpoofAndPublish() {
  Mode.dhcpSpoofModeOn()
    .then(() => {
      publish(Mode.MODE_DHCP_SPOOF);
    })
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
  setDHCPSpoofAndPublish: setDHCPSpoofAndPublish,
  setManualSpoofAndPublish: setManualSpoofAndPublish,
  setNoneAndPublish: setNoneAndPublish,
  publishManualSpoofUpdate: publishManualSpoofUpdate,
  publishNetworkInterfaceUpdate: publishNetworkInterfaceUpdate,
  enableSecondaryInterface:_enableSecondaryInterface,
  toggleCompatibleSpoof: toggleCompatibleSpoof
}
