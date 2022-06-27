/*    Copyright 2019-2022 Firewalla Inc.
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

const log = require('./logger.js')(__filename);
const Config = require('./config.js');
const Promise = require('bluebird');
const cp = require('child_process');
const execAsync = Promise.promisify(cp.exec);
const fs = require('fs');
const readFileAsync = Promise.promisify(fs.readFile);
const writeFileAsync = Promise.promisify(fs.writeFile);
const sem = require('../sensor/SensorEventManager.js').getInstance();
const iptables = require('../net2/Iptables');
const firewalla = require('../net2/Firewalla.js');
const Discovery = require('../net2/Discovery.js');
const discovery = new Discovery("nmap", null, "info");

const intfConfigs = {};

const HOSTAPD_TEMPLATE_PATH = `${firewalla.getFirewallaHome()}/extension/wifi/hostapd.conf.template`;


function listenOnChange() {
  sem.on("WirelessInterfaceDetected", async (event) => {
    const intfs = event.intfs || [];
    if (intfs.length == 0) {
      log.info("No wireless interface is detected.");
      return;
    }
    const fConfig = await Config.getConfig(true);
    if (!fConfig.wifiInterface)
      return;
    const wifiIntf = (fConfig.wifiInterface && fConfig.wifiInterface.intf) || "wlan0";
    if (!intfs.includes(wifiIntf)) {
      // rename wifi interface name to what specified in config.wifiInterface
      const intf = intfs[0];
      if (intfs.length > 1) // only support one wireless interface currently
        log.warn(`Multiple wifi interfaces detected, only ${intf} will be used.`);
      await _renameInterface(intf, wifiIntf);
    }
    // interfame with name specified in config.wifiInterface should be ready now
    await _configureWifi(fConfig.wifiInterface);
  });
}

async function _renameInterface(oldIntf, newIntf) {
  if (!oldIntf || !newIntf || oldIntf === newIntf)
    return;
  let cmd = `sudo ip link set ${oldIntf} down`;
  await execAsync(cmd);
  cmd = `sudo ip link set ${oldIntf} name ${newIntf}`;
  await execAsync(cmd);
  cmd = `sudo ip link set ${newIntf} up`
  await execAsync(cmd);
}

async function _configureWifi(config) {
  /*
    "wifiInterface": {
      "intf": "wlan0",
      "ip": "10.0.218.1/24",
      "mode": "router",
      "ssid": "FW_AP",
      "password": "1234567",
      "band": "g",
      "channel": "5"
    }
  */
  const intf = config.intf;
  const mode = config.mode || "router";

  if (!intf)
    return;
  const currentConfig = intfConfigs[intf];
  try {
    switch (mode) {
      case "router":
        if (!config.ip) {
          log.error(`'ip' is required for ${intf} to run ${mode} mode`);
          return;
        }
        if (JSON.stringify(currentConfig) !== JSON.stringify(config)) {
          log.info("Update wifi interface: ", config);
          // remove old MASQUERADE rule from iptables if present
          if (currentConfig && currentConfig.ip)
            await iptables.dhcpSubnetChangeAsync(currentConfig.ip, false);
          // remove master of the interface
          let cmd = `sudo ip link set ${intf} nomaster`;
          await execAsync(cmd);
          cmd = "sudo nmcli radio wifi off"; // detach wifi management from NetworkManager
          await execAsync(cmd);
          cmd = "sudo rfkill unblock wlan"; // unblock wlan interfaces so that ifconfig can work
          await execAsync(cmd);
          cmd = "sudo rfkill unblock wifi";
          await execAsync(cmd);
          // set ip subnet of interface accordingly
          cmd = `sudo ifconfig ${intf} ${config.ip} up`;
          await execAsync(cmd);
          await _enableHostapd(config);
          setTimeout(async () => {
            await discovery.discoverInterfacesAsync();
          }, 10000); // awaiting wlan interface being brought up
        }
        // ensure MASQUERADE rule is added to iptables
        await iptables.dhcpSubnetChangeAsync(config.ip, true);
        intfConfigs[intf] = config;
        break;
      case "bridge":
        // TODO: support bridge mode for wifi interface
        break;
      default:
        log.error(`Unknown mode ${mode} for wifi interface ${intf}`);
    }
  } catch (err) {
    log.error("Failed to configure interface.", config, err);
  }
}

async function _enableHostapd(config) {
  /*
    "wifiInterface": {
      "intf": "wlan0",
      "ip": "10.0.218.1/24",
      "mode": "router",
      "ssid": "FW_AP",
      "password": "1234567",
      "band": "g",
      "channel": "5"
    }
  */
  const intf = config.intf;
  if (!intf)
    return;
  const band = config.band || "g";
  const channel = config.channel || "5";
  const ssid = config.ssid || "FW_AP";
  const password = config.password || "firewalla";
  let conf = await readFileAsync(HOSTAPD_TEMPLATE_PATH, 'utf8');
  conf = conf.replace("<INTERFACE_NAME>", config.intf);
  conf = conf.replace("<BAND>", band);
  conf = conf.replace("<CHANNEL>", channel);
  conf = conf.replace("<SSID>", ssid);
  conf = conf.replace("<PASSWORD>", password);
  await writeFileAsync(`${firewalla.getFirewallaHome()}/extension/wifi/${intf}.conf`, conf, 'utf8');
  const cmd = `sudo systemctl restart firewifi@${intf}`;
  await execAsync(cmd);
}

module.exports = {
  listenOnChange: listenOnChange
}
