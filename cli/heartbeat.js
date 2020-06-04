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

const exec = require('child-process-promise').exec;
const fs = require('fs');
const io2 = require('socket.io-client');
const os = require('os');
const socket = io2(
  "https://api.firewalla.com",
  { path: "/socket",
    transports: ['websocket'],
    'upgrade': false }
);
const Promise = require('bluebird');
Promise.promisifyAll(fs);

function log(message) {
  console.log(new Date(), message);
}

async function getShellOutput(cmd) {
  try {
    const result = await exec(cmd, { encoding: 'utf8' });
    return result && result.stdout && result.stdout.replace(/\n$/,'');
  } catch(err) {
    log("ERROR: "+err);
    return "";
  }
}

async function isBooted() {
  const fwHeartbeatFile = '/dev/shm/fw_heartbeat';
  try{
    await fs.accessAsync(fwHeartbeatFile, fs.constants.F_OK);
    return false;
  } catch (err) {
    log("System was booted.");
    await exec(`touch ${fwHeartbeatFile}`);
    return true;
  }
}

async function getCpuTemperature() {
  return await getShellOutput("cat /sys/class/thermal/thermal_zone0/temp");
}

function getEthernets() {
    const ifs = os.networkInterfaces();
    const eths = {};
    const ethsNames = Object.keys(ifs).filter(name => name.match(/^eth/));
    ethsNames.forEach(e => eths[e]=ifs[e]);
    return eths;
}

async function getEthernetSpeed(ethsNames) {
    const ethSpeed = {};
    for (const eth of ethsNames) {
      ethSpeed[eth] = await getShellOutput(`sudo ethtool ${eth} | awk '/Speed:/ {print $2}'`);
    }
    return ethSpeed;
}

async function getGatewayMac() {
  const gwIP = await getShellOutput("route -n | awk '$1 == \"0.0.0.0\" {print $2}'");
  if ( gwIP ) {
    const gwMac = await getShellOutput(`arp -a -n | grep ${gwIP} -w | awk '{print $4}'`);
    return gwMac;
  } else {
    return '';
  }
}

async function getLatestCommitHash(cwd) {
  try {
    const result = await exec("git rev-parse HEAD", { cwd: cwd, encoding: 'utf8' });
    return result && result.stdout && result.stdout.trim();
  } catch(err) {
    //log(`ERROR: failed to get latest commit hash in ${cwd}`+err);
    return '';
  }
}

async function getLicenseInfo() {
  const licenseFile = "/home/pi/.firewalla/license";
  const SUUID = (await getShellOutput(`awk '/SUUID/ {print $NF}' ${licenseFile}`)).replace(/[",]/g,'');
  const EID = (await getShellOutput(`awk '/EID/ {print $NF}' ${licenseFile}`)).replace(/[",]/g,'');
  return { SUUID,EID };
}

async function getSysinfo(status) {
  const eths = getEthernets();
  const memory = os.totalmem()
  const timestamp = Date.now();
  const uptime = os.uptime();
  const [arch, booted, btMac, cpuTemp, ethSpeed, gatewayMac, hashRouter, hashWalla, licenseInfo, mac] =
    await Promise.all([
      getShellOutput("uname -m"),
      isBooted(),
      getShellOutput("hcitool dev | awk '/hci0/ {print $2}'"),
      getCpuTemperature(),
      getEthernetSpeed(Object.keys(eths)),
      getGatewayMac(),
      getLatestCommitHash("/home/pi/firerouter"),
      getLatestCommitHash("/home/pi/firewalla"),
      getLicenseInfo(),
      getShellOutput("cat /sys/class/net/eth0/address")
    ]);
  return {
    arch,
    booted,
    btMac,
    cpuTemp,
    eths,
    ethSpeed,
    licenseInfo,
    gatewayMac,
    hashRouter,
    hashWalla,
    mac,
    memory,
    status,
    timestamp,
    uptime
  };
}

async function update(status) {
  const info = await getSysinfo(status);
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
