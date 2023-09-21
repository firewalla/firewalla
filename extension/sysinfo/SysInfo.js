/*    Copyright 2019-2021 Firewalla Inc.
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

const log = require("../../net2/logger.js")(__filename, "info");

const util = require('util');

const f = require('../../net2/Firewalla.js');
const logFolder = f.getLogFolder();

const config = require("../../net2/config.js").getConfig();

const df = util.promisify(require('node-df'))

const os = require('../../vendor_lib/osutils.js');

const exec = require('child-process-promise').exec;
const { execSync } = require('child_process')

const rclient = require('../../util/redis_manager.js').getRedisClient()

const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const rateLimit = require('../../extension/ratelimit/RateLimit.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

let cpuUsage = 0;
let cpuModel = 'Not Available';
let distCodename = null;
let realMemUsage = 0;
let usedMem = 0;
let allMem = 0;
let curTemp = 0;
let peakTemp = 0;

let conn = 0;
let peakConn = 0;

let rateLimitInfo = null;

let redisMemory = 0;

let updateFlag = 0;

let updateInterval = 600 * 1000; // every 10 minutes

let threadInfo = {};

let diskInfo = null;

let ethInfo = {};
let wlanInfo = {}
let slabInfo = {};

let intelQueueSize = 0;

let multiProfileSupport = false;

let no_auto_upgrade = false;

let uptimeInfo = {};
let updateTime = null;

let maxPid = 0;
let activeContainers = 0;

let diskUsage = {};

let releaseInfo = {};


getMultiProfileSupportFlag();

async function update() {
  await Promise.all([
    // this takes 10s
    os.cpuUsage().then((v) => cpuUsage = v),

    // Redis
    getRedisMemoryUsage()
      .then(getConns)
      .then(getIntelQueueSize)
      .then(getRateLimitInfo),

    // bash
    getRealMemoryUsage()
      .then(getTemp)
      .then(getThreadInfo)
      .then(getDiskInfo)
      .then(getMultiProfileSupportFlag)
      .then(getAutoUpgrade)
      .then(getUptimeInfo)
      .then(getMaxPid)
      .then(getActiveContainers)
      .then(getEthernetInfo)
      .then(getWlanInfo)
      .then(getSlabInfo)
      .then(getDiskUsage)
      .then(getReleaseInfo)
      .then(getCPUModel)
      .then(getDistributionCodename)
  ]);

  if(updateFlag) {
    setTimeout(() => { update(); }, updateInterval);
  }
}



function startUpdating() {
  updateFlag = 1;
  update();
}

function stopUpdating() {
  updateFlag = 0;
}

async function getThreadInfo() {
  try {
    const count = await exec("ps -Haux | wc -l", {encoding: 'utf8'});
    const mainCount = await exec("ps -Haux | grep Fi[r]eMain | wc -l", {encoding: 'utf8'});
    const apiCount = await exec("ps -Haux | grep Fi[r]eApi | wc -l", {encoding: 'utf8'});
    const monitorCount = await exec("ps -Haux | grep Fi[r]eMon | wc -l", {encoding: 'utf8'});
    threadInfo.count = count.stdout.replace("\n", "");
    threadInfo.mainCount = mainCount.stdout.replace("\n", "");
    threadInfo.apiCount = apiCount.stdout.replace("\n", "");
    threadInfo.monitorCount = monitorCount.stdout.replace("\n", "");
  } catch(err) {
    log.error("Failed to get thread info", err);
  }
}

async function getUptimeInfo() {
  try {
    uptimeInfo.fireMain = 0;
    uptimeInfo.FireApi = 0;
    uptimeInfo.FireMon = 0;
    uptimeInfo.bitbridge6 = 0;
    uptimeInfo.bitbridge7 = 0;
    uptimeInfo.dnscrypt = 0;
    uptimeInfo.dnsmasq = 0;
    uptimeInfo.openvpn = 0;

    const cmdResult = await exec("ps -eo etimes,cmd | awk '{print $1, $2}'", {encoding: 'utf8'});
    let lines = cmdResult.stdout.split("\n");
    lines.shift();
    lines.pop();
    updateTime = Date.now() / 1000;
    for (const line of lines) {
      let contents = line.split(' ');
      if (contents[1] == "FireMain") {
        uptimeInfo.fireMain = Number(contents[0])
      } else if (contents[1] == "FireApi") {
        uptimeInfo.FireApi = Number(contents[0])
      } else if (contents[1] == "FireMon") {
        uptimeInfo.FireMon = Number(contents[0])
      } else if (contents[1].indexOf("bitbridge6") > -1) {
        uptimeInfo.bitbridge6 = Number(contents[0])
      } else if (contents[1].indexOf("bitbridge7") > -1) {
        uptimeInfo.bitbridge7 = Number(contents[0])
      } else if (contents[1].indexOf("dnscrypt") > -1) {
        uptimeInfo.dnscrypt = Number(contents[0])
      } else if (contents[1].indexOf("dnsmasq") > -1) {
        uptimeInfo.dnsmasq = Number(contents[0])
      } else if (contents[1].indexOf("openvpn") > -1) {
        uptimeInfo.openvpn = Number(contents[0])
      }
    }
  } catch(err) {
    log.error("Failed to get uptime info", err);
  }
}

async function getRateLimitInfo() {
  rateLimitInfo = await rateLimit.getLastTS();
}

async function getDiskInfo() {
  try {
    const response = await df()
    const disks = response.filter(entry => ["/dev/mmc", "/dev/sda", "overlay"].some(x => entry.filesystem.startsWith(x)));
    diskInfo = disks;
  } catch(err) {
    log.error("Failed to get disk info", err);
  }
}

function getAutoUpgrade() {
  return new Promise((resolve, reject) => {
    fs.exists("/home/pi/.firewalla/config/.no_auto_upgrade", function(exists) {
      no_auto_upgrade = exists;
      resolve(no_auto_upgrade);
    });
  })
}

async function getMultiProfileSupportFlag() {
  const cmd = "sudo bash -c 'test -e /etc/openvpn/easy-rsa/keys2/ta.key'"
  try {
    await exec(cmd);
    multiProfileSupport = false;
  } catch(err) {
    multiProfileSupport = true;
  }
}

async function getIntelQueueSize() {
  intelQueueSize = await rclient.zcountAsync("ip_set_to_be_processed", "-inf", "+inf");
}

async function getRealMemoryUsage() {
  try {
    const res = await exec('free');
    var lines = res.stdout.split(/\n/g);
    for(var i = 0; i < lines.length; i++) {
      lines[i] = lines[i].split(/\s+/);
    }

    usedMem = parseInt(lines[1][2]);
    allMem = parseInt(lines[1][1]);
    realMemUsage = 1.0 * usedMem / allMem;
    log.debug("Memory Usage: ", usedMem, " ", allMem, " ", realMemUsage);
  } catch (err) {
    log.error("Failed to get memory usuage:", err);
  }
}

async function getTemp() {
  try {
    curTemp = await platform.getCpuTemperature();
    if (Array.isArray(curTemp)) curTemp = curTemp[0]
    log.debug("Current Temp: ", curTemp);
    peakTemp = peakTemp > curTemp ? peakTemp : curTemp;
  } catch(err) {
    log.debug("Failed getting CPU temperature", err);
    curTemp = -1;
  }
}

function getUptime() {
  return process.uptime();
}

function getOSUptime() {
  return require('os').uptime();
}

function getTimestamp() {
  return new Date();
}

async function getConns() {
  // get conns in last 24 hours
  try {
    const keys = await rclient.keysAsync('flow:conn:*');

    let results = await Promise.all(
      keys.map(key => rclient.zcountAsync(key, '-inf', '+inf'))
    );

    if(results.length > 0) {
      conn = results.reduce((a,b) => (a + b));
      peakConn = peakConn > conn ? peakConn : conn;
    }
  } catch(err) {
    log.error("Failed getting connections in 24 hrs", err);
    conn = -1;
    return;
  }
}

async function getCPUModel() {
  const cmd = "lscpu | awk  -F : '/Model name/ {print $2}'";
  try {
    const res = await exec(cmd);
    cpuModel = res.stdout.trim();
    log.debug(`CPU model name: ${cpuModel}`);
  } catch(err) {
    log.error("Error getting CPU model name", err);
  }
}

async function getDistributionCodename() {
  const cmd = `lsb_release -cs`;
  distCodename = await exec(cmd).then(result => result.stdout.trim()).catch((err) => {
    log.error(`Cannot get distribution codename`, err.message);
    return null;
  });
}

async function getRedisMemoryUsage() {
  const cmd = "redis-cli info | grep used_memory: | awk -F: '{print $2}'";
  try {
    const res = await exec(cmd);
    redisMemory = res.stdout.replace(/\r?\n$/,'');
  } catch(err) {
    log.error("Error getting Redis memory usage", err);
  }
}

function getCategoryStats() {
  try {
    const output = execSync(`${f.getFirewallaHome()}/scripts/category_blocking_stats.sh`, {encoding: 'utf8'})
    const lines = output.split("\n");

    let stats = {};
    lines.forEach((line) => {
      const entries = line.split(" ");
      const category = entries[0];
      const num = entries[1];
      stats[category] = num;
    })

    return stats;

  } catch(err) {
    return {};
  }
}

async function getMaxPid() {
  try {
    const cmd = await exec('echo $$')
    const pid = Number(cmd.stdout)
    if (pid < maxPid) {
      log.debug(`maxPid decresed. max: ${maxPid}, now: ${pid}`)
    } else {
      maxPid = pid
    }
  } catch(err) {
    log.error("Error getting max pid", err)
  }
}

async function getActiveContainers() {
  try {
    if (! platform.isDockerSupported()) { return; }
    const active = await exec(`sudo systemctl -q is-active docker`).then(() => true).catch((err) => false);
    if (active) {
      const cmd = await exec('sudo docker container ls -q | wc -l')
      activeContainers = Number(cmd.stdout)
    } else
      activeContainers = 0;
    log.debug(`active docker containers count = ${activeContainers}`);
  } catch(err) {
    log.error("failed to get number of active docker containers", err)
  }
}

function getSysInfo() {
  let sysinfo = {
    cpu: cpuUsage,
    cpuModel: cpuModel,
    distCodename: distCodename,
    mem: 1 - os.freememPercentage(),
    realMem: realMemUsage,
    totalMem: os.totalmem(),
    load1: os.loadavg(1),
    load5: os.loadavg(5),
    load15: os.loadavg(15),
    curTemp: curTemp + "",
    peakTemp: peakTemp + "",
    timestamp: getTimestamp(),
    uptime: getUptime(),
    osUptime: getOSUptime(),
    conn: conn + "",
    peakConn: peakConn + "",
    redisMem: redisMemory,
    releaseType: f.getReleaseType(),
    threadInfo: threadInfo,
    intelQueueSize: intelQueueSize,
    nodeVersion: process.version,
    diskInfo: diskInfo || [],
    //categoryStats: getCategoryStats(),
    multiProfileSupport: multiProfileSupport,
    no_auto_upgrade: no_auto_upgrade,
    maxPid: maxPid,
    ethInfo,
    wlanInfo,
    slabInfo,
    diskUsage: diskUsage,
    releaseInfo: releaseInfo
  }

  let newUptimeInfo = {};
  Object.keys(uptimeInfo).forEach((uptimeName) => {
    if (uptimeInfo[uptimeName] > 0 ) {
      newUptimeInfo[uptimeName] = uptimeInfo[uptimeName] + Date.now() / 1000 - updateTime; // add time difference between update and getSysInfo()
    } else {
      newUptimeInfo[uptimeName] = 0;
    }
  });
  sysinfo.uptimeInfo = newUptimeInfo;

  if(rateLimitInfo) {
    sysinfo.rateLimitInfo = rateLimitInfo;
  }

  if (platform.isDockerSupported()) {
    sysinfo.activeContainers = activeContainers;
  }

  return sysinfo;
}

async function getRecentLogs() {
  const logFiles = ["api.log", "kickui.log", "main.log", "monitor.log", "dns.log"].map((name) => logFolder + "/" + name);

  const tailNum = config.sysInfo.tailNum || 100; // default 100

  let results = await Promise.all(logFiles.map(async file => {
    // ignore all errors
    try {
      let res = await exec(util.format('tail -n %d %s', tailNum, file))
      return { file: file, content: res.stdout }
    } catch(err) {
      return { file: file, content: "" }
    }
  }));

  return results
}

function getTopStats() {
  return execSync("top -b -n 1 -o %MEM | head -n 20").toString('utf-8').split("\n");
}

async function getTop5Flows() {
  let flows = await rclient.keysAsync("flow:conn:*");

  let stats = await Promise.all(flows.map(async (flow) => {
    let count = await rclient.zcountAsync(flow, "-inf", "+inf")
    return {name: flow, count: count};
  }))

  return stats.sort((a, b) => b.count - a.count).slice(0, 5);
}

async function getPerfStats() {
  return {
    top: getTopStats(),
    sys: getSysInfo(),
    perf: await getTop5Flows()
  }
}

function getHeapDump(file, callback) {
  callback(null);
  // let heapdump = require('heapdump');
  // heapdump.writeSnapshot(file, callback);
}

async function getEthernetInfo() {
  const localEthInfo = {};
  switch (platform.getName()) {
    case "purple": {
      const eth0_crc = await exec("ethtool -S eth0 | fgrep mmc_rx_crc_error: | awk '{print $2}'").then((output) => output.stdout && output.stdout.trim()).catch((err) => -1); // return -1 when err
      localEthInfo.eth0_crc = Number(eth0_crc);
      break;
    }
    case "gse": {
      const eth1_crc = await exec("ethtool -S eth1 | fgrep mmc_rx_crc_error: | awk '{print $2}'" ).then((output) => output.stdout && output.stdout.trim()).catch((err) => -1);
      const eth2_crc = await exec("ethtool -S eth2 | fgrep mmc_rx_crc_error: | awk '{print $2}'" ).then((output) => output.stdout && output.stdout.trim()).catch((err) => -1);
      localEthInfo.eth1_crc = Number(eth1_crc);
      localEthInfo.eth2_crc = Number(eth2_crc);
      break;
    }
    default:
  }
  const items = ["tx_timeout", "link_up", "link_down"];
  for (const nic of platform.getAllNicNames()) {
    for (const item of items) {
      switch (item) {
        case "tx_timeout": {
          const result = await exec(`cat /sys/class/net/${nic}/queues/tx-*/tx_timeout`)
            .then((output) => output.stdout && output.stdout.trim().split('\n').filter(line => !isNaN(line)).reduce((sum, line) => sum + Number(line), 0))
            .catch((err) => 0);
          localEthInfo[`${nic}_tx_timeout`] = result;
          break;
        }
        case "link_up": {
          const result = await fs.readFileAsync(`/sys/class/net/${nic}/carrier_up_count`, {encoding: "utf8"}).then(content => Number(content.trim())).catch((err) => 0);
          localEthInfo[`${nic}_link_up`] = result;
          break;
        }
        case "link_down": {
          const result = await fs.readFileAsync(`/sys/class/net/${nic}/carrier_down_count`, {encoding: "utf8"}).then(content => Number(content.trim())).catch((err) => 0);
          localEthInfo[`${nic}_link_down`] = result;
          break;
        }
      }
    }
  }
  ethInfo = localEthInfo;

  const netdevWatchdog = await rclient.hgetallAsync('sys:log:netdev_watchdog')
  if (netdevWatchdog) localEthInfo.netdevWatchdog = netdevWatchdog
}

async function getWlanInfo() {
  for (const intf of platform.getAllNicNames()) try {
    const res = await exec(`iwconfig ${intf} | grep Quality`).catch(() => null)
    if (!res || !res.stdout || !res.stdout.length) {
      log.debug('[getWlanInfo] skipping', intf, 'no output')
      continue
    }

    const segments = res.stdout.split('=')
    // unconnected interface might be
    // Link Quality:0  Signal level:0  Noise level:0
    if (segments.length == 1) {
      log.debug('[getWlanInfo] not connected', intf, segments)
      wlanInfo[intf] = {};
      continue
    }

    // Link Quality=80/100  Signal level=53/100  Noise level=0/100
    for (const i in segments) {
      segments[i] = segments[i].split('/')
    }
    log.debug('[getWlanInfo]', segments)
    if (!wlanInfo[intf]) wlanInfo[intf] = {}
    const wlan = wlanInfo[intf]
    wlan.quality = segments[1][0]
    wlan.signal = segments[2][0]
    wlan.noise = segments[3][0]
  } catch(err) {
    log.error('Failed to parse wlan info for', intf, err)
  }

  wlanInfo.kernelReload = await rclient.getAsync('sys:wlan:kernelReload')
  log.verbose('[getWlanInfo] results', wlanInfo)
  return wlanInfo
}

async function getSlabInfo() {
  return exec('sudo cat /proc/slabinfo | tail +2 | grep "^#\\|^kmalloc\\|^task_struct"').then(result => result.stdout.trim().split("\n")).then(lines => {
    const head = lines[0];
    const columns = head.substring(2).split(/\s+/);
    slabInfo = {};
    let total = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const values = line.split(/\s+/);
      let name = null;
      let num_objs = 0;
      let objsize = 0;
      for (let j = 0; j < values.length; j++) {
        switch (columns[j]) {
          case "name":
            name = values[j];
            break;
          case "<num_objs>":
            num_objs = values[j];
            break;
          case "<objsize>":
            objsize = values[j];
            break;
          default:
        }
      }
      slabInfo[name] = num_objs * objsize;
      total += num_objs * objsize;
    }
    slabInfo["total"] = total;
    return slabInfo
  }).catch((err) => {
    return null;
  });
}

async function getDiskUsage(path) {
  try {
    const resultFW = await exec("du -sk /home/pi/firewalla|awk '{print $1}'", {encoding: 'utf8'});
    diskUsage.firewalla = resultFW.stdout.trim();
    const resultFR = await exec("du -sk /home/pi/firerouter|awk '{print $1}'", {encoding: 'utf8'});
    diskUsage.firerouter = resultFR.stdout.trim();
  } catch(err) {
    log.error("Failed to get disk usage", err);
  }
}

async function getReleaseInfo() {
  return exec('cat /etc/firewalla_release').then(result => result.stdout.trim().split("\n")).then(lines => {
    releaseInfo = {};
    lines.forEach(line => {
      const [key,value] = line.split(/: (.+)?/,2);
      releaseInfo[key.replace(/\s/g,'')]=value;
    })
    return releaseInfo;
  }).catch((err) => {
    log.error("failed to get release info from /etc/firewalla_release",err.message)
    return {};
  });
}

module.exports = {
  getSysInfo: getSysInfo,
  startUpdating: startUpdating,
  stopUpdating: stopUpdating,
  getRealMemoryUsage:getRealMemoryUsage,
  getRecentLogs: getRecentLogs,
  getPerfStats: getPerfStats,
  getHeapDump: getHeapDump
};
