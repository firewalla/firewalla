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
  *   box license
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
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const socket = io2(
  "https://api.firewalla.com",
  { path: "/socket",
    transports: ['websocket'],
    'upgrade': false }
);
const Promise = require('bluebird');
Promise.promisifyAll(fs);

process.title = 'FireHB';
const launchTime = Math.floor(new Date() / 1000);

let uid = null;

function getUniqueID(info) {
  const randomNumber = Math.floor(Math.random() * 1000000);
  if(info.mac) {
    return `${info.mac.toUpperCase()}-${launchTime}-${randomNumber}`;
  } else {
    return `INVALID_MAC-${launchTime}-${randomNumber}`;
  }
}

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

async function getIPLinks() {
  const ipLinks = await getShellOutput("ip link show");
  return ipLinks.split("\n");
}

async function getEthernetSpeed() {
    const eths = await getShellOutput("cd /sys/class/net; ls -1d eth* | fgrep -v .");
    if (!eths) return "";
    const ethSpeed = {};
    for (const eth of eths.split("\n")) {
      ethSpeed[eth] = await getShellOutput(`sudo ethtool ${eth} | awk '/Speed:/ {print $2}'`);
    }
    return ethSpeed;
}

async function getGatewayMacPrefix() {
  const gwIP = await getShellOutput("route -n | awk '$1 == \"0.0.0.0\" {print $2}'");
  if ( gwIP ) {
    const gwMacPrefix = await getShellOutput(`arp -a -n | grep ${gwIP} -w | awk '{print $4}' | cut -d: -f1-3`);
    return gwMacPrefix;
  } else {
    return '';
  }
}

async function getGitBranchName(cwd) {
  try {
    const result = await exec("git rev-parse --abbrev-ref HEAD", { cwd: cwd, encoding: 'utf8' });
    return result && result.stdout && result.stdout.trim();
  } catch(err) {
    //log(`ERROR: failed to get latest branch name in ${cwd}`+err);
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
  return ['SUUID', 'UUID', 'EID', 'LICENSE'].reduce( async (result,licenseField) => {
    result = await result;
    result[licenseField] = (await getShellOutput(`awk '/"${licenseField}"/ {print $NF}' ${licenseFile}`)).replace(/[",]/g,'');
    return result;
  },{});
}

async function getSysinfo(status) {
  const ifs = os.networkInterfaces();
  const memory = os.totalmem()
  const timestamp = Date.now();
  const uptime = os.uptime();
  const [arch, booted, btMac, cpuTemp, ethSpeed, gatewayMacPrefix, gitBranchName, hashRouter, hashWalla, licenseInfo, mac, mode, redisEid] =
    await Promise.all([
      getShellOutput("uname -m"),
      isBooted(),
      getShellOutput("hcitool dev | awk '/hci0/ {print $2}'"),
      getCpuTemperature(),
      getEthernetSpeed(),
      getGatewayMacPrefix(),
      getGitBranchName(),
      getLatestCommitHash("/home/pi/firerouter"),
      getLatestCommitHash("/home/pi/firewalla"),
      getLicenseInfo(),
      getShellOutput("cat /sys/class/net/eth0/address"),
      getShellOutput("redis-cli get mode"),
      getShellOutput("redis-cli hget sys:ept eid")
    ]);

  if(!uid) {
    uid = getUniqueID({mac});
  }

  return {
    arch,
    booted,
    btMac,
    cpuTemp,
    ifs,
    ethSpeed,
    licenseInfo,
    gatewayMacPrefix,
    gitBranchName,
    hashRouter,
    hashWalla,
    mac,
    memory,
    mode,
    redisEid,
    status,
    timestamp,
    uptime,
    uid
  };
}

async function update(status, extra) {
  let info = await getSysinfo(status);
  if(extra) {
    info = Object.assign({}, info, extra);
  }
  //log(`DEBUG: ${JSON.stringify(info,null,2)}`);
  socket.emit('update', info);
  return info;
}

const job = setInterval(() => {
  update("schedule");
}, 24 * 3600 * 1000); // every day

/* DEBUG
const job2 = setTimeout(() => {
  update("schedule");
}, 3000); // every 3 sec
 */

socket.on('connect', async () => {
  log("Connected to heartbeat server.");
  update('connect');
});

socket.on('disconnect', () => {
  log("Disconnected from heartbeat server.");
});

socket.on('update', () => {
  update("cloud");
});

socket.on('upgrade', () => {
  log("Upgrade started via heartbeat");
  exec("/home/pi/firewalla/scripts/fireupgrade_check.sh");
});

socket.on('reconnect', () => {
  log("Reconnected to heartbeat server.");
  //update('reconnect');
});

const eventName = "FIREWALLA:HEARTBEAT:UPDATE";
sclient.on("message", (channel, message) => {
  if(channel === eventName) {
    try {
      const object = JSON.parse(message);
      update('redis', object);
    } catch(err) {
      log("Failed to parse redis message.");
    }
  }
});
sclient.subscribe(eventName);
