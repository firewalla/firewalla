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
const pclient = require('../util/redis_manager.js').getPublishClient()
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

let sysStateCount = { "normal": 0, "overheated": 0 };
let overheatedThresholds = null;
(async function() {
  overheatedThresholds = await getOverheatedThresholds();
  setInterval(async () => { await monitorTemperature(); }, 30 * 1000); // every 30 seconds
})()

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

async function getDiskFree() {
  const dfFree = await getShellOutput("df -h; df -hi");
  return dfFree.split("\n");
}

async function getEthernetSpeed() {
    const eths = await getShellOutput("ls -l /sys/class/net | awk '/^l/ && !/virtual/ {print $9}'");
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
  return  fs.existsSync(licenseFile) ?
    ['SUUID', 'UUID', 'EID', 'LICENSE'].reduce( async (result,licenseField) => {
        result = await result;
        result[licenseField] = (await getShellOutput(`awk '/"${licenseField}"/ {print $NF}' ${licenseFile}`)).replace(/[",]/g,'');
        return result;
    },{}) : {};
}

async function getServiceActiveSince() {
  let fireServices = ['firekick', 'firemain', 'fireapi', 'firemon','firemasq','firerouter','firereset','firerouter_dns','firerouter_dhcp']
  return fireServices.reduce( async (result,svc) => {
    result = await result;
    result[svc] = (await getShellOutput(`sudo systemctl status ${svc} | sed -n 's/.*since \\(.*\\);.*/\\1/p'`));
    return result;
  },{});
}

async function getRedisInfoMemory() {
  const rcimOutput = await getShellOutput("redis-cli info memory | grep used_memory_ | grep -v _human");
  return rcimOutput.split("\n").reduce( (result, item) => {
    const [item_key, item_value] = item.trim("\r").split(':')
    if ( item_value ) result[item_key] = item_value
      return result;
    },{} )
}

async function getSysinfo(status) {
  const ifs = os.networkInterfaces();
  const memory = os.totalmem()
  const timestamp = Date.now();
  const uptime = os.uptime();
  const [arch, booted, btMac, cpuTemp, diskFree, ethSpeed, gatewayMacPrefix, gitBranchName, hashRouter, hashWalla, licenseInfo, mac, mode, serviceActiveSince, redisEid, redisInfoMemory] =
    await Promise.all([
      getShellOutput("uname -m"),
      isBooted(),
      getShellOutput("hcitool dev | awk '/hci0/ {print $2}'"),
      getCpuTemperature(),
      getDiskFree(),
      getEthernetSpeed(),
      getGatewayMacPrefix(),
      getGitBranchName(),
      getLatestCommitHash("/home/pi/firerouter"),
      getLatestCommitHash("/home/pi/firewalla"),
      getLicenseInfo(),
      getShellOutput("cat /sys/class/net/eth0/address"),
      getShellOutput("redis-cli get mode"),
      getServiceActiveSince(),
      getShellOutput("redis-cli hget sys:ept eid"),
      getRedisInfoMemory()
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
    diskFree,
    ethSpeed,
    licenseInfo,
    gatewayMacPrefix,
    gitBranchName,
    hashRouter,
    hashWalla,
    mac,
    memory,
    mode,
    serviceActiveSince,
    redisEid,
    redisInfoMemory,
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

async function getOverheatedThresholds() {
  const uname = await getShellOutput("uname -m");
  let temperatureThreshold = null;
  let countThreshold = null;
  switch (uname) {
    case "aarch64": {
      const boardName = await getShellOutput("awk -F= '/BOARD=/ {print $2}' /etc/firewalla-release");
      switch (boardName) {
        case "blue": {
          temperatureThreshold = 255;
          countThreshold = 255;
          break;
        }
        case "navy": {
          temperatureThreshold = 85;
          countThreshold = 20;
          break;
        }
      }
      break;
    }
    case "armv7l": {
      // red
      temperatureThreshold = 255;
      countThreshold = 255;
      break;
    }
    case "x86_64": {
      // gold
      temperatureThreshold = 85;
      countThreshold = 20;
      break;
    }
    default:
      temperatureThreshold = 100;
      countThreshold = 100;
  }
  return {temperatureThreshold,countThreshold};
}

async function updateSysStateInRedis(sysStateCurrent, cpuTemperature) {
  const sysStateInRedis = await getShellOutput("redis-cli get sys:state");
  //log("sysStateCurrent:"+sysStateCurrent);
  //log("sysStateInRedis:"+sysStateInRedis);
  if ( sysStateCurrent === sysStateInRedis ) { return; }
  await exec(`redis-cli set sys:state ${sysStateCurrent}`, { encoding: 'utf8' });

  const featureFlag = await getShellOutput("redis-cli hget sys:features temp_monitor_notif");
  if (featureFlag != "1") {
    return;
  }

  const curStateUpperCase = sysStateCurrent.toUpperCase();

  const event = {
    type: 'FW_NOTIFICATION',
    titleKey: `FW_OVERHEATED_TITLE_${curStateUpperCase}`,
    bodyKey: `FW_OVERHEATED_BODY_${curStateUpperCase}`,
    titleLocalKey: `FW_OVERHEATED_${curStateUpperCase}`,
    bodyLocalKey: `FW_OVERHEATED_${curStateUpperCase}`,
    bodyLocalArgs: [cpuTemperature],
    payload: {
      cpuTemperature: cpuTemperature,
    },
    fromProcess: process.title,
    toProcess: "FireApi"
  };
  // publish to FireApi via redis
  //log("publish");
  pclient.publish(`TO.${event.toProcess}`, JSON.stringify(event));
}

async function monitorTemperature() {
  try {
      const cpuTempCurrent = await getCpuTemperature();
      const cpuTempThreshold = 1000*overheatedThresholds.temperatureThreshold;
      const sysStateCurrent = (cpuTempCurrent>cpuTempThreshold) ? "overheated":"normal";
      const sysStateOther = (cpuTempCurrent>cpuTempThreshold) ? "normal":"overheated";
      sysStateCount[sysStateOther] = 0; // reset other state
      //log("cpuTempCurrent:"+cpuTempCurrent);
      //log("cpuTempThreshold:"+cpuTempThreshold);
      //log("sysStateCurrent:"+sysStateCurrent);
      if ( ++sysStateCount[sysStateCurrent] > overheatedThresholds.countThreshold ) {
        await updateSysStateInRedis(sysStateCurrent, cpuTempCurrent);
        sysStateCount[sysStateCurrent] = 0;
      }
  } catch (err) {
      log(`Failed to monitor CPU temperature: ${err}`);
  }
  return ;
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
