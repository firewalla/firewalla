/*    Copyright 2020 Firewalla INC
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

 /*
  * Box (collect the following info)
  *   box states: just rebooted, this process crashed and connect, reconnected the socket io, scheduled update
  *   memory size
  *   mac addresses of ethX
  *   speed of each ethX
  *   Bluetooth mac address
  *   uptime
  *   uname -m
  *   box eid (if have)
  *   box license (8 char prefix only)
  *   gateway mac address (the first three bytes)
  *   cpu temp
  *   current timestamp
  *   hash of firerouter (if applicable)
  *   hash of firewalla
  */

'use strict';

const cp = require('child_process');
const fs = require('fs');
const io2 = require('socket.io-client');
const os = require('os');
const socket = io2(
  "https://api.firewalla.com",
  { path: "/socket",
    transports: ['websocket'],
    'upgrade': false }
);

// private modules
const licenseUtil = require('../util/license.js');

// persistent system info
const arch = getShellOutput("uname -m");
const btmac = getShellOutput("hcitool dev  | awk '/hci0/ {print $2}'");
const mac = getShellOutput("cat /sys/class/net/eth0/address").toUpperCase();
const memory = os.totalmem()

function log(message) {
  console.log(new Date(), message);
}

function getShellOutput(cmd) {
  try {
    const result = cp.execSync(cmd, { encoding: 'utf8' });
    return result && result.trim();
  } catch(err) {
    return "";
  }
}

function isBooted() {
  const fwHeartbeatFile = '/dev/shm/fw_heartbeat';
  try{
    if (fs.existsSync(fwHeartbeatFile)) {
      return false;
    } else {
      log("System was booted.");
      cp.execSync(`touch ${fwHeartbeatFile}`)
      return true;
    }
  } catch (err) {
    return false;
  }
}

function getCpuTemperature() {
  return getShellOutput("cat /sys/class/thermal/thermal_zone0/temp");
}

function getEthernets() {
    const ifs = os.networkInterfaces()
    const eths = {}
    const ethsNames = Object.keys(ifs).filter(name => name.match(/^eth/));
    ethsNames.forEach(e => eths[e]=ifs[e])
    return eths
}

function getEthernetSpeed(ethsNames) {
    const ethspeed = {}
    ethsNames.forEach( eth => {
      ethspeed[eth] = getShellOutput(`sudo ethtool ${eth} | awk '/Speed:/ {print $2}'`);
    })
    return ethspeed
}

function getLatestCommitHash(cwd) {
  try {
    const result = cp.execSync("git rev-parse HEAD", { cwd: cwd, encoding: 'utf8' });
    return result && result.trim();
  } catch(err) {
    return '';
  }
}

function getLicenseInfo() {
  const licenseData = licenseUtil.getLicenseLicense();
  const licenseInfo = {};
  const licenseFields = ['EID','SUUID'];
  licenseFields.forEach(field => licenseInfo[field] = licenseData[field]);
  return licenseInfo;
}

function getSysinfo(status) {
  const booted = isBooted();
  const cputemp = getCpuTemperature();
  const eths = getEthernets();
  const ethspeed = getEthernetSpeed(Object.keys(eths));
  const hashRouter = getLatestCommitHash("/home/pi/firerouter");
  const hashWalla = getLatestCommitHash("/home/pi/firewalla");
  const licenseInfo = getLicenseInfo();
  const timestamp = Date.now();
  const uptime = os.uptime()
  return {
    arch,
    booted,
    btmac,
    cputemp,
    eths,
    ethspeed,
    licenseInfo,
    hashRouter,
    hashWalla,
    mac,
    memory,
    status,
    timestamp,
    uptime
  };
}

function update(status) {
  const info = getSysinfo(status);
  //log(`DEBUG: ${JSON.stringify(info,null,2)}`);
  socket.emit('update', info);
}

const job = setTimeout(() => {
  update("schedule");
}, 30 * 3600 * 1000);

socket.on('connect', () => {
  log("Connected to heartbeat server.");
  update('connect');
});

socket.on('disconnect', () => {
  log("Disconnected from heartbeat server.");
});

socket.on("update", (data) => {
  update("cloud");
});

socket.on('reconnect', () => {
  log("Reconnected to heartbeat server.");
  update('reconnect');
});