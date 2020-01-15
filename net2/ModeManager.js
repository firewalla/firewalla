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
const wrapIptables = iptables.wrapIptables;
const firewalla = require('./Firewalla.js')

let util = require('util');
const iptool = require('ip');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let curMode = null;

const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const HostTool = require('./HostTool.js');
const hostTool = new HostTool();

const cp = require('child_process');
const execAsync = util.promisify(cp.exec);

const AUTO_REVERT_INTERVAL = 600 * 1000 // 10 minutes

let timer = null

async function _revert2None() {
  timer = null
  let bootingComplete = await firewalla.isBootingComplete()
  let firstBindDone = await firewalla.isFirstBindDone()
  if (!bootingComplete && firstBindDone) {
    log.warn("Revert back to none mode for safety")
    return switchToNone()
  }
}

async function _enforceSpoofMode() {
  try {
    let bootingComplete = await firewalla.isBootingComplete()
    let firstBindDone = await firewalla.isFirstBindDone()

    if (!bootingComplete && firstBindDone) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // init stage, reset to none after X seconds if booting not complete
      timer = setTimeout(_revert2None, AUTO_REVERT_INTERVAL)
    }

    let sm = new SpooferManager();
    sm.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway(), sysManager.myIp(), false);
    // register v6 spoof instance if v6 gateway is assigned
    if (sysManager.myGateway6() && sysManager.myIp6()) { // empty string also returns false
      sm.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway6(), sysManager.myIp6()[0], true);
      if (sysManager.myDNS() && sysManager.myDNS().includes(sysManager.myGateway())) {
        // v4 dns includes gateway ip, very likely gateway's v6 addresses are dns servers, need to spoof these addresses (no matter public or linklocal)
        const gateway = await hostTool.getMacEntryByIP(sysManager.myGateway());
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
    await sm.startSpoofing()
    log.info("New Spoof is started");
  } catch (err) {
    log.error("Failed to start new spoof", err);
  }
}

function _disableSpoofMode() {
  let sm = new SpooferManager();
  log.info("Stopping spoofing");
  return sm.stopSpoofing()
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
  // check if is same subnet
  const currIpSubnet = iptool.cidrSubnet(oldIpSubnet);
  const altIp = iptool.cidrSubnet(altIpSubnet);
  if (!currIpSubnet.contains(altIp.networkAddress)
    || currIpSubnet.subnetMaskLength !== altIp.subnetMaskLength
    || !currIpSubnet.contains(altGateway)) {
    log.info("Alternative ip or gateway is not in current subnet, change ignore")
    return;
  }
  let cmd = "";
  // kill dhclient before change eth0 ip address, in case it is overridden by dhcp
  cmd = "pgrep -x dhclient && sudo pkill dhclient; true";
  try {
    await execAsync(cmd);
  } catch (err) {
    log.warn("Failed to kill dhclient");
  }
  if (oldIpSubnet !== altIpSubnet) {
    // delete old ip from eth0
    try {
      cmd = util.format("sudo /sbin/ip addr del %s dev eth0", oldIpSubnet);
      log.info("Command to remove old ip assignment: " + cmd);
      await execAsync(cmd);
      // dns rule change is done in dnsmasq.js
    } catch (err) {
      log.warn(util.format("Old ip subnet %s is not found on eth0.", oldIpSubnet));
    }

    cmd = util.format("sudo /sbin/ip addr replace %s dev eth0", altIpSubnet);
    log.info("Command to add alternative ip assignment: " + cmd);
    await execAsync(cmd);
    // dns rule change is done in dnsmasq.js
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

    cmd = util.format("sudo sed -i --follow-symlinks s/%s/%s/g /etc/resolv.conf", oldGateway, altGateway);
    log.info("Command to update resolv.conf: " + cmd);
    await execAsync(cmd);
    const savedResolvFile = firewalla.getHiddenFolder() + "/run/saved_resolv.conf";
    cmd = util.format("sudo /bin/cp -f /etc/resolv.conf %s", savedResolvFile);
    await execAsync(cmd);
  }

  await d.discoverInterfacesAsync();
  await sysManager.updateAsync();
}

async function _enableSecondaryInterface() {
  fConfig = Config.getConfig(true);

  try {
    let { secondaryIpSubnet, legacyIpSubnet } = await secondaryInterface.create(fConfig)
    log.info("Successfully created secondary interface");
    if (legacyIpSubnet) { // secondary ip is changed
      await d.discoverInterfacesAsync()
      await sysManager.updateAsync()
      // secondary interface ip changed, reload sysManager in all Fire* processes
      try {
        // legacyIpSubnet should be like 192.168.218.0/24
        // dns change is done in dnsmasq.js
        await iptables.dhcpSubnetChangeAsync(legacyIpSubnet, false); // remove old DHCP MASQUERADE rule
        await iptables.dhcpSubnetChangeAsync(secondaryIpSubnet, true); // add new DHCP MASQUERADE rule
      } catch (err) {
        log.error("Failed to update nat for legacy IP subnet: " + legacyIpSubnet, err);
        throw err;
      }
    }
  } catch (err) {
    log.error("Failed to enable secondary interface, err:", err);
  }
}

async function _enforceDHCPMode() {
  // need to kill dhclient otherwise ip lease will be relinquished once it is expired, causing system reboot
  const cmd = "pgrep -x dhclient && sudo pkill dhclient; true";
  try {
    await execAsync(cmd);
  } catch (err) {
    log.warn("Failed to kill dhclient");
  }
  return Promise.resolve();
}

function _disableDHCPMode() {
  return Promise.resolve();
}

async function toggleCompatibleSpoof(state) {
  if (state) {
    let cmd = wrapIptables("sudo iptables -w -t nat -A POSTROUTING -m set --match-set monitored_ip_set src -j MASQUERADE");
    await execAsync(cmd);
    cmd = wrapIptables("sudo ip6tables -w -t nat -A POSTROUTING -m set --match-set monitored_ip_set6 src -j MASQUERADE");
    await execAsync(cmd);
  } else {
    let cmd = wrapIptables("sudo iptables -w -t nat -D POSTROUTING -m set --match-set monitored_ip_set src -j MASQUERADE");
    await execAsync(cmd);
    cmd = wrapIptables("sudo ip6tables -w -t nat -D POSTROUTING -m set --match-set monitored_ip_set6 src -j MASQUERADE");
    await execAsync(cmd);
  }
}

async function apply() {
  let mode = await Mode.getSetupMode()

  curMode = mode;

  log.info("Applying mode", mode, "...");

  let HostManager = require('./HostManager.js')
  let hostManager = new HostManager('cli', 'server', 'info')

  switch (mode) {
    case Mode.MODE_DHCP:
      //await _saveSimpleModeNetworkSettings() // no need to do this anymore, primary interface IP is editable now
      await _changeToAlternativeIpSubnet();
      await _enableSecondaryInterface();
      await _enforceDHCPMode();
      await pclient.publishAsync("System:IPChange", "");
      break;
    case Mode.MODE_DHCP_SPOOF:
    case Mode.MODE_AUTO_SPOOF:
      await _changeToAlternativeIpSubnet();
      await _enableSecondaryInterface(); // secondary interface ip/subnet may be changed
      //await _restoreSimpleModeNetworkSettings() // no need to do this anymore, primary interface IP is ediatable now
      await _enforceSpoofMode();
      await pclient.publishAsync("System:IPChange", "");
      // reset oper history for each device, so that we can re-apply spoof commands
      hostManager.cleanHostOperationHistory()

      await hostManager.getHostsAsync()
      if (mode === Mode.MODE_DHCP_SPOOF) {
        // enhanced spoof is necessary for dhcp spoof
        hostManager.setPolicy("enhancedSpoof", true);
        // dhcp service is needed for dhcp spoof mode
        await _enforceDHCPMode()
      }
      break;
    case Mode.MODE_MANUAL_SPOOF:
      await _enforceSpoofMode()
      let sm = new SpooferManager();
      await hostManager.getHostsAsync()
      await sm.loadManualSpoofs(hostManager) // populate monitored_hosts based on manual Spoof configs
      break;
    case Mode.MODE_NONE:
      // no thing
      break;
    default:
      // not supported
      throw new Error(util.format("mode %s is not supported", mode));
  }
  sem.emitEvent({
    type: 'Mode:Applied',
    mode: mode,
    message: `Mode is applied: ${mode}`
  });
}

async function switchToNone() {
  log.info("Switching to none")
  await Mode.noneModeOn()
  await _disableDHCPMode()
  await _disableSpoofMode()
  return apply()
}

async function reapply() {
  let lastMode = await Mode.getSetupMode()
  log.info("Old mode is", lastMode)

  switch (lastMode) {
    case "spoof":
    case "autoSpoof":
    case "manualSpoof":
      await _disableSpoofMode()
      break;
    case "dhcp":
      await _disableDHCPMode()
      break;
    case "dhcpSpoof":
      await _disableSpoofMode()
      await _disableDHCPMode()
      break;
    case "none":
      // do nothing
      break;
    default:
      break;
  }

  await Mode.reloadSetupMode()
  return apply()
}

function mode() {
  return Mode.reloadSetupMode();
}

// listen on mode change, if anyone update mode in redis, re-apply it
function listenOnChange() {
  sclient.on("message", async (channel, message) => {
    if (channel === "Mode:Change") {
      if (curMode !== message) {
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
      await _changeToAlternativeIpSubnet()
      await _enableSecondaryInterface()
      pclient.publishAsync("System:IPChange", "");
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

async function setNoneAndPublish() {
  await Mode.noneModeOn()
  await publish(Mode.MODE_NONE)
}

module.exports = {
  apply: apply,
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
  enableSecondaryInterface: _enableSecondaryInterface,
  toggleCompatibleSpoof: toggleCompatibleSpoof
}
