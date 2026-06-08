/*    Copyright 2019-2024 Firewalla Inc.
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
const fs = require('fs');

const f = require('../../net2/Firewalla.js');
const logFolder = f.getLogFolder();

const config = require("../../net2/config.js").getConfig();
const upgradeManager = require('../../net2/UpgradeManager.js')
const { fileExist }  = require('../../util/util.js')

const df = util.promisify(require('node-df'))

const os = require('../../vendor_lib/osutils.js');

const exec = require('child-process-promise').exec;
const { execSync } = require('child_process')

const rclient = require('../../util/redis_manager.js').getRedisClient()

const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const rateLimit = require('../../extension/ratelimit/RateLimit.js');

const Constants = require("../../net2/Constants.js");

const ethInfoKey = "ethInfo";

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

let kernelVersion = null;

let no_auto_upgrade = false;

let uptimeInfo = {};
let updateTime = null;

let maxPid = 0;
let activeContainers = 0;

let diskUsage = {};

let releaseInfo = {};

let emmcLife = null;

const REDIS_DISKSTATS_DAILY_KEY = 'sys:diskstats:daily';

// sectors written from /proc/diskstats at process start (boot baseline), BigInt per device
let diskStatsBootBaseline = null;
// cumulative sectors written loaded from Redis (covers prior boots), BigInt per device
let diskStatsSavedCumulative = {};
// unix seconds when cumulative tracking first began
let diskStatsStartTime = 0;
// dayTs (floor to day) for which we've already written a Redis entry
let diskStatsTodayTs = 0;
// reported stats: { startTime, devices: {dev: Mbytes}, yearlyWriteGB }
let diskWriteStats = {};

function isDiskStatsDevice(name) {
  // whole eMMC/SD device or numbered partition, exclude boot/rpmb partitions
  return /^mmcblk\d+(p\d+)?$/.test(name) || /^sda\d*$/.test(name);
}

async function readRawDiskStats() {
  const content = await fs.promises.readFile('/proc/diskstats', 'utf8');
  const result = {};
  for (const line of content.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const name = parts[2];
    if (!isDiskStatsDevice(name)) continue;
    result[name] = BigInt(parts[9]); // raw write sectors as 64-bit BigInt
  }
  return result;
}


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
      .then(getDiskWriteStats)
      .then(getReleaseInfo)
      .then(getCPUModel)
      .then(getDistributionCodename)
      .then(getEmmcLife)
  ]);

  if(updateFlag) {
    setTimeout(() => { update(); }, updateInterval);
  }
}



async function startUpdating() {
  updateFlag = 1;
  await update();
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

async function getEmmcLife() {
  try {
    const result = await exec("sudo bash -c 'cat /sys/kernel/debug/*mmc*/*mmc*:*/ext_csd 2>/dev/null | head -n 1'");
    const hex = result.stdout.trim();
    if (hex.length < 540) return;
    emmcLife = {
      preEolInfo: parseInt(hex.substr(267 * 2, 2), 16),
      lifeTimeEstA: parseInt(hex.substr(268 * 2, 2), 16),
      lifeTimeEstB: parseInt(hex.substr(269 * 2, 2), 16),
    };
  } catch (err) {
    log.debug("Failed to read eMMC ext_csd:", err.message);
  }
}

async function getAutoUpgrade() {
  return fileExist('/home/pi/.firewalla/config/.no_auto_upgrade').catch(err => {
    log.error('Failed to get upgrade flag', err);
    return false
  })
}

async function getKernelVersion() {
  if (!kernelVersion) {
    kernelVersion = await exec("uname -r").then(result => result.stdout.trim()).catch((err) => {
      log.error("Failed to get kernel version via uname -r", err.message);
      return null;
    });
  }
  return kernelVersion;
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

function getTop10RSSProcesses() {
  try {
    const psOutput = execSync(
      'ps -eo pid,rss,comm,args:256 --no-headers --sort=-rss | head -n 10',
      { encoding: 'utf-8' }
    ).trim().split('\n');

    return psOutput.map(line => {
      const [pid, rss, comm, ...args] = line.trim().split(/\s+/);
      let exePath = '';
      try {
        exePath = execSync(`sudo readlink /proc/${pid}/exe`, { encoding: 'utf-8' }).trim();
      } catch (e) {
        // if can't get exe path, use comm name
        exePath = comm || 'unknown';
      }
      return {
        pid: parseInt(pid),
        rss: rss,
        exe: exePath,
        command: comm,
        args: args.filter(a => a).join(' ')
      };
    });
  } catch (err) {
    log.error("Failed to get top 10 RSS processes:", err);
    return [];
  }
}

async function getSysInfo() {
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
    kernelVersion: await getKernelVersion(),
    procVersion: await exec("cat /proc/version").then(result => result.stdout.trim()).catch(err => null),
    diskInfo: diskInfo || [],
    //categoryStats: getCategoryStats(),
    multiProfileSupport: multiProfileSupport,
    no_auto_upgrade: await getAutoUpgrade(),
    autoupgrade: await upgradeManager.getAutoUpgradeFlags(),
    maxPid: maxPid,
    ethInfo,
    wlanInfo,
    slabInfo,
    diskUsage: diskUsage,
    diskWriteStats: diskWriteStats,
    processes : getTop10RSSProcesses(),
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

  if (emmcLife) {
    sysinfo.emmcLife = emmcLife;
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
    sys: await getSysInfo(),
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
  const info = await rclient.hgetallAsync(Constants.REDIS_KEY_ETH_INFO);
  ethInfo = Object.assign(localEthInfo, info);

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

// parse a per-device value from a Redis daily entry to BigInt sectors.
// new format: string (raw sectors); old format: number (MB, pre-BigInt migration).
function _parseSectorsFromRedis(val) {
  if (typeof val === 'string') return BigInt(val);
}

async function getDiskWriteStats() {
  try {
    const now = Math.floor(Date.now() / 1000);

    if (diskStatsBootBaseline === null) {
      // load saved cumulative from the most recent Redis daily entry
      const newestEntries = await rclient.zrangeAsync(REDIS_DISKSTATS_DAILY_KEY, -1, -1);
      if (newestEntries && newestEntries.length > 0) {
        const newest = JSON.parse(newestEntries[0]);
        diskStatsSavedCumulative = {};
        for (const [dev, val] of Object.entries(newest.devices || {})) {
          diskStatsSavedCumulative[dev] = _parseSectorsFromRedis(val);
        }
        if (now - newest.t >= 2 * 86400) {
          log.warn(`diskstats: latest Redis entry is ${Math.round((now - newest.t) / 86400)} day(s) old`);
        }
      }
      // startTime = timestamp of the oldest recorded entry
      const oldestEntries = await rclient.zrangeAsync(REDIS_DISKSTATS_DAILY_KEY, 0, 0);
      diskStatsStartTime = oldestEntries && oldestEntries.length > 0 ? JSON.parse(oldestEntries[0]).t : now;
      diskStatsBootBaseline = await readRawDiskStats();
    }

    const current = await readRawDiskStats();
    const deviceSectors = {}; // BigInt sectors per device

    for (const [dev, currentSectors] of Object.entries(current)) {
      const bootSectors = diskStatsBootBaseline[dev] || 0n;
      const savedSectors = diskStatsSavedCumulative[dev] || 0n;
      const delta = currentSectors >= bootSectors ? currentSectors - bootSectors : 0n;
      deviceSectors[dev] = savedSectors + delta;
    }

    // write today's daily snapshot only once (at startup or when today's entry is absent)
    const dayTs = Math.floor(now / 86400) * 86400;
    if (diskStatsTodayTs !== dayTs) {
      const todayExisting = await rclient.zrangebyscoreAsync(REDIS_DISKSTATS_DAILY_KEY, dayTs, dayTs);
      if (!todayExisting || todayExisting.length === 0) {
        // store sector counts as strings to preserve 64-bit precision
        const devicesForRedis = {};
        for (const [dev, sectors] of Object.entries(deviceSectors)) {
          devicesForRedis[dev] = sectors.toString();
        }
        await rclient.zaddAsync(REDIS_DISKSTATS_DAILY_KEY, dayTs, JSON.stringify({ t: dayTs, devices: devicesForRedis }));
        await rclient.zremrangebyrankAsync(REDIS_DISKSTATS_DAILY_KEY, 0, -(366 + 1)); // keep last 366 days
      }
      diskStatsTodayTs = dayTs;
    }

    // yearly estimate: deviceSectors (today) minus the entry from exactly 365 days ago
    let yearlyWriteGB = {};
    const day365AgoTs = dayTs - 365 * 86400;
    const day365Entries = await rclient.zrangebyscoreAsync(REDIS_DISKSTATS_DAILY_KEY, day365AgoTs, day365AgoTs);
    if (day365Entries && day365Entries.length > 0) {
      const day365ago = JSON.parse(day365Entries[0]);
      for (const dev of Object.keys(deviceSectors)) {
        if (day365ago.devices[dev] != null) {
          const oldSectors = _parseSectorsFromRedis(day365ago.devices[dev]);
          const deltaSectors = deviceSectors[dev] > oldSectors ? deviceSectors[dev] - oldSectors : 0n;
          yearlyWriteGB[dev] = Number(deltaSectors / 2048n) / 1024; // sectors → MB → GB
        }
      }
    } else {
      log.warn(`diskstats: no entry from 365 days ago (ts ${day365AgoTs}), use (current - oldest)/days * 365 as estimate`);
      const oldestEntries = await rclient.zrangeAsync(REDIS_DISKSTATS_DAILY_KEY, 0, 0);
      if (oldestEntries && oldestEntries.length > 0) {
        const oldest = JSON.parse(oldestEntries[0]);
        if (oldest.t === dayTs) {
          log.warn(`diskstats: oldest entry is from today, not enough history data to make yearly estimate`);
        } else {
          const days = (now - oldest.t) / 86400 + 1; // add 1 day to avoid under-estimate
          for (const dev of Object.keys(deviceSectors)) {
            if (oldest.devices[dev] != null) {
              const oldSectors = _parseSectorsFromRedis(oldest.devices[dev]);
              const deltaSectors = deviceSectors[dev] > oldSectors ? deviceSectors[dev] - oldSectors : 0n;
              yearlyWriteGB[dev] = Number(deltaSectors / 2048n) / days * 365 / 1024; // sectors → MB → GB
            }
          }
        }
      }
    }

    // convert BigInt sectors to integer MB for the external API
    const devices = {};
    for (const [dev, sectors] of Object.entries(deviceSectors)) {
      devices[dev] = Number(sectors / 2048n); // integer MB
    }

    diskWriteStats = { startTime: diskStatsStartTime, devices, yearlyWriteGB };
    return diskWriteStats;
  } catch (err) {
    log.error("Failed to get disk write stats", err);
  }
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
  getHeapDump: getHeapDump,
  getAutoUpgrade,
  getDiskWriteStats,
};
