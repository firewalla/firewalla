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

const dockerEmmcUsageModule = require('../docker/dockerEmmcUsage.js');

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
let updateLoopStarted = false;

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

let dockerEmmcUsage = null;

const USB_SYSFS_DIR = "/sys/bus/usb/devices";
// USB-IF class codes, see https://www.usb.org/defined-class-codes. bluetooth is the only
// accessory of interest with a standard class, wifi dongles use vendor specific classes
const USB_CLASS_HUB = "09";
const USB_CLASS_WIRELESS = "e0";
const USB_SUBCLASS_RF = "01";
const USB_PROTOCOL_BLUETOOTH = "01";
// dongles known to be used with the box, a fallback for the case that the dongle is plugged in
// but its driver did not come up. see also platform/*/files/udev/55-start_ble.rules
const BT_DONGLE_IDS = ["0a12:0001", "0bda:a729"];
// RTL8821CU family, 1a2b is the CD-ROM mode it enumerates as before usb_modeswitch kicks in
const WIFI_DONGLE_IDS = ["0bda:c811", "0bda:c820", "0bda:1a2b"];
// lsusb result is cached this long, so that a dongle plugged in shows up on the next init
// without waiting for a full SysInfo update cycle, and repeated getSysInfo() stay cheap
const USB_INFO_TTL = 60 * 1000;
// {bluetooth, wifi, other, devices}, null if the USB bus cannot be listed at all
let usbInfo = null;
let usbInfoTs = 0;
let usbInfoPromise = null;
let lsusbFailed = false;

const REDIS_DISKSTATS_DAILY_KEY = 'sys:diskstats:daily';

// sectors written from /proc/diskstats at process start (boot baseline), BigInt per device
let diskStatsBootBaseline = null;
// cumulative sectors written loaded from Redis (covers prior boots), BigInt per device
let diskStatsSavedCumulative = {};
// unix seconds when cumulative tracking first began
let diskStatsStartTime = 0;
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
  try {
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
        .then(getDockerEmmcUsage)
    ]);
  } catch (err) {
    log.error("Failed to update sysinfo", err);
  } finally {
    if(updateFlag) {
      setTimeout(() => { update(); }, updateInterval);
    } else {
      updateLoopStarted = false;
    }
  }
}



async function startUpdating(options = {}) {
  updateFlag = 1;
  if (updateLoopStarted) return;
  updateLoopStarted = true;
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

async function getDockerEmmcUsage() {
  try {
    dockerEmmcUsage = await dockerEmmcUsageModule.getEmmcUsage();
  } catch (err) {
    log.debug("Failed to get docker eMMC usage:", err.message);
    dockerEmmcUsage = [];
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

// Wraps an async producer with a TTL cache and in-flight de-dup, same pattern as the
// usbInfoPromise guard on getUsbInfo() below: getSysInfo() can be called concurrently
// (e.g. by both basicDataForInit() and extensionDataForInit() in the same init request),
// so without de-dup a slow/expensive producer would otherwise run once per caller.
// A falsy/null result is never cached, so a failed lookup is retried on the next call.
// ttlMs === Infinity caches the first successful result forever.
function cachedAsync(producer, ttlMs) {
  let value, ts = 0, inflight = null;
  return async function() {
    if (ts && (ttlMs === Infinity || Date.now() - ts < ttlMs))
      return value;
    if (!inflight) {
      inflight = producer().then((result) => {
        if (result != null) {
          value = result;
          ts = Date.now();
        }
        inflight = null;
        return result;
      }).catch((err) => {
        inflight = null;
        throw err;
      });
    }
    return inflight;
  };
}

// /proc/version never changes without a reboot, so cache it forever like kernelVersion above.
const getProcVersion = cachedAsync(
  () => exec("cat /proc/version").then(result => result.stdout.trim()).catch(err => null),
  Infinity
);

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
  // DestIPFoundHook now keeps the work queue in node memory and publishes its size here
  intelQueueSize = Number(await rclient.getAsync("metric:intel:queue:size")) || 0;
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

async function computeTop10RSSProcesses() {
  try {
    const psOutput = await exec('ps -eo pid,rss,comm,args:256 --no-headers --sort=-rss | head -n 10')
      .then(result => result.stdout.trim().split('\n').filter(l => l));

    const procs = psOutput.map(line => {
      const [pid, rss, comm, ...args] = line.trim().split(/\s+/);
      return { pid: parseInt(pid), rss, comm, args: args.filter(a => a).join(' '), exe: null };
    }).filter(p => Number.isInteger(p.pid) && p.pid > 0);

    // Reading /proc/<pid>/exe directly needs no subprocess at all, and works for any
    // process this user can ptrace (own uid, or already root) - which is most of them.
    // Only processes owned by another user hit the sudo fallback below.
    const needSudo = [];
    await Promise.all(procs.map(async (p) => {
      try {
        p.exe = await fs.promises.readlink(`/proc/${p.pid}/exe`);
      } catch (err) {
        needSudo.push(p);
      }
    }));

    // Batch whatever's left into a single sudo call instead of one sudo spawn per pid -
    // pids are guaranteed numeric (parsed above), so safe to interpolate into the script.
    if (needSudo.length) {
      const script = needSudo.map(p => `echo "${p.pid} $(readlink /proc/${p.pid}/exe 2>/dev/null)"`).join('; ');
      const exeByPid = await exec(`sudo bash -c '${script}'`).then(result => {
        const map = {};
        for (const line of result.stdout.trim().split('\n')) {
          const idx = line.indexOf(' ');
          if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1).trim();
        }
        return map;
      }).catch(() => ({}));
      for (const p of needSudo)
        p.exe = exeByPid[p.pid] || null;
    }

    return procs.map(p => ({
      pid: p.pid,
      rss: p.rss,
      exe: p.exe || p.comm || 'unknown',
      command: p.comm,
      args: p.args
    }));
  } catch (err) {
    log.error("Failed to get top 10 RSS processes:", err);
    return [];
  }
}

// Diagnostic snapshot, doesn't need per-request freshness; short TTL + in-flight de-dup
// keeps repeated/concurrent getSysInfo() calls cheap. See cachedAsync() above.
const getTop10RSSProcesses = cachedAsync(computeTop10RSSProcesses, 5 * 1000);

async function getSysInfo() {
  // independent lookups (some cached, some live), run in parallel rather than serially
  const [kernelVersionVal, procVersion, noAutoUpgrade, autoupgrade, usbInfoVal, processes] = await Promise.all([
    getKernelVersion(),
    getProcVersion(),
    getAutoUpgrade(),
    upgradeManager.getAutoUpgradeFlags(),
    getUsbInfo(),
    getTop10RSSProcesses(),
  ]);

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
    kernelVersion: kernelVersionVal,
    procVersion,
    diskInfo: diskInfo || [],
    //categoryStats: getCategoryStats(),
    multiProfileSupport: multiProfileSupport,
    no_auto_upgrade: noAutoUpgrade,
    autoupgrade,
    maxPid: maxPid,
    ethInfo,
    wlanInfo,
    usbInfo: usbInfoVal,
    slabInfo,
    diskUsage: diskUsage,
    diskWriteStats: diskWriteStats,
    processes,
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

  if (dockerEmmcUsage && dockerEmmcUsage.length > 0) {
    sysinfo.dockerEmmcUsage = dockerEmmcUsage;
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

// returns the non-zero error counters of a NIC from `ethtool -S`, keyed as <nic>_<counter>,
// null if ethtool fails, e.g. the driver does not support statistics.
// counter names vary by driver, e.g. mmc_rx_crc_error(stmmac), rx_crc_errors(igb), so simply take
// the ones with error in the name, same as `ethtool -S ethX | grep error`
async function getEthErrorStats(nic) {
  const output = await exec(`ethtool -S ${nic}`).then((result) => result.stdout).catch((err) => null);
  if (!output)
    return null;
  const stats = {};
  let crc = null;
  for (const line of output.split("\n")) {
    // e.g. "     mmc_rx_crc_error: 0", ethtool indents counters by 5 spaces, \s* just in case.
    // the "NIC statistics:" header does not match anyway, there is no number after the colon
    const match = line.match(/^\s*(\S.*?):\s*(\d+)\s*$/);
    if (!match || !/error/i.test(match[1]))
      continue;
    // keep the key clean, some drivers put spaces or brackets in the name, e.g. "Queue[0]_InErrors"
    // of enetc becomes Queue_0_InErrors, "Tx LPI entry counter" of igb becomes Tx_LPI_entry_counter
    const name = match[1].trim().replace(/[\W_]+/g, "_").replace(/^_|_$/g, "");
    const value = Number(match[2]);
    // fcs as well as crc, the frame check sequence is the CRC, some drivers name it rx_fcs_errors.
    // max instead of sum, a driver may count CRC errors in multiple registers, e.g. stmmac on gse/pse
    // reports both mmc_rx_crc_error and rx_crc_errors
    if (/crc|fcs/i.test(name))
      crc = Math.max(crc === null ? 0 : crc, value);
    if (value) // only report non-zero counters, otherwise the payload gets bloated by dozens of idle counters per NIC
      stats[`${nic}_${name}`] = value;
  }
  if (crc !== null) // <nic>_crc is kept for backward compatibility
    stats[`${nic}_crc`] = crc;
  return stats;
}

async function getEthernetInfo() {
  const localEthInfo = {};
  for (const nic of platform.getAllNicNames().filter(nic => nic.startsWith("eth"))) {
    if (!await fileExist(`/sys/class/net/${nic}/ifindex`)) // NIC not present on this box
      continue;
    // negotiated link speed in Mbps, -1 when the link is down. a NIC running below the speed it
    // supports usually comes together with the error counters below going up
    const speed = await fs.promises.readFile(`/sys/class/net/${nic}/speed`, {encoding: "utf8"})
      .then((content) => Number(content.trim())).catch((err) => NaN);
    if (!isNaN(speed))
      localEthInfo[`${nic}_speed`] = speed;
    const stats = await getEthErrorStats(nic);
    if (stats)
      Object.assign(localEthInfo, stats);
    else
      localEthInfo[`${nic}_crc`] = -1; // -1 indicates ethtool failure
  }
  const info = await rclient.hgetallAsync(Constants.REDIS_KEY_ETH_INFO);
  ethInfo = Object.assign(localEthInfo, info);

  const netdevWatchdog = await rclient.hgetallAsync('sys:log:netdev_watchdog')
  if (netdevWatchdog) localEthInfo.netdevWatchdog = netdevWatchdog
}

async function getWlanInfo() {
  const localWlanInfo = {};

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
      localWlanInfo[intf] = {};
      continue
    }
    // Link Quality=80/100  Signal level=53/100  Noise level=0/100
    for (const i in segments) {
      segments[i] = segments[i].split('/')
    }
    log.debug('[getWlanInfo]', segments)
    if (!localWlanInfo[intf]) localWlanInfo[intf] = {}
    const wlan = localWlanInfo[intf]
    wlan.quality = segments[1][0]
    wlan.signal = segments[2][0]
    wlan.noise = segments[3][0]
  } catch(err) {
    log.error('Failed to parse wlan info for', intf, err)
  }

  localWlanInfo.kernelReload = await rclient.getAsync('sys:wlan:kernelReload')
  wlanInfo = localWlanInfo;

  log.verbose('[getWlanInfo] results', wlanInfo)
  return wlanInfo
}

async function pathExists(path) {
  return fs.promises.access(path, fs.constants.F_OK).then(() => true).catch(() => false);
}

async function readSysfsValue(path) {
  return fs.promises.readFile(path, {encoding: "utf8"}).then((content) => content.trim()).catch((err) => null);
}

// a wireless netdev has either of these, a wired one has neither. used to tell a wifi dongle
// apart from a NIC of the box that sits on the USB bus
async function isWirelessNetdev(name) {
  return await pathExists(`/sys/class/net/${name}/wireless`) || await pathExists(`/sys/class/net/${name}/phy80211`);
}

// reads what lsusb does not tell: the class of every USB device and the kernel devices its
// driver brought up. keyed by "<busnum>-<devnum>" so it can be joined with the lsusb output
async function readUsbSysfs() {
  const devices = {};
  const entries = await fs.promises.readdir(USB_SYSFS_DIR).catch((err) => {
    log.info("Failed to read", USB_SYSFS_DIR, err.message);
    return [];
  });
  for (const entry of entries) {
    // interface directories are named <device>:<config>.<interface>, they are read below as
    // part of their parent device
    if (entry.includes(":"))
      continue;
    const dir = `${USB_SYSFS_DIR}/${entry}`;
    const [busnum, devnum, deviceClass] = await Promise.all([
      readSysfsValue(`${dir}/busnum`),
      readSysfsValue(`${dir}/devnum`),
      readSysfsValue(`${dir}/bDeviceClass`),
    ]);
    if (!busnum || !devnum)
      continue;
    const device = {class: deviceClass, interfaces: [], netdevs: [], hasBluetooth: false};
    const children = await fs.promises.readdir(dir).catch((err) => []);
    for (const child of children.filter(c => c.startsWith(`${entry}:`))) {
      const ifDir = `${dir}/${child}`;
      const [cls, subClass, protocol] = await Promise.all([
        readSysfsValue(`${ifDir}/bInterfaceClass`),
        readSysfsValue(`${ifDir}/bInterfaceSubClass`),
        readSysfsValue(`${ifDir}/bInterfaceProtocol`),
      ]);
      device.interfaces.push({cls, subClass, protocol});
      // the driver of the interface publishes its kernel device here, e.g. btusb creates
      // bluetooth/hci0 and r8152 creates net/eth0
      device.netdevs.push(...await fs.promises.readdir(`${ifDir}/net`).catch((err) => []));
      if (await pathExists(`${ifDir}/bluetooth`))
        device.hasBluetooth = true;
    }
    devices[`${Number(busnum)}-${Number(devnum)}`] = device;
  }
  return devices;
}

// hubs are skipped altogether, the hubs built into the box are indistinguishable from an
// external one, and whatever is plugged into a hub is enumerated on its own anyway
function isUsbHub(id, name, device) {
  if (device.class === USB_CLASS_HUB || device.interfaces.some(i => i.cls === USB_CLASS_HUB))
    return true;
  // fallback in case sysfs is not readable, 1d6b is the vendor of the virtual root hubs
  return id.startsWith("1d6b:") || /\bhub\b/i.test(name);
}

// devices that are part of the box are not accessories, e.g. eth0 of pse is a USB NIC
async function isNativeUsbDevice(id, device, nativeIds, nicNames) {
  if (nativeIds.includes(id))
    return true;
  for (const netdev of device.netdevs)
    // wlan interfaces are reserved on the models taking a wifi dongle, so a netdev only counts
    // as native when it is a wired one
    if (nicNames.includes(netdev) && !await isWirelessNetdev(netdev))
      return true;
  return false;
}

function isUsbBluetooth(id, name, device) {
  if (device.hasBluetooth)
    return true;
  if (device.interfaces.some(i => i.cls === USB_CLASS_WIRELESS && i.subClass === USB_SUBCLASS_RF && i.protocol === USB_PROTOCOL_BLUETOOTH))
    return true;
  // a dongle whose driver did not come up, or whose descriptors are not readable
  return BT_DONGLE_IDS.includes(id) || /bluetooth/i.test(name);
}

async function isUsbWifi(id, name, device) {
  for (const netdev of device.netdevs)
    if (await isWirelessNetdev(netdev))
      return true;
  // wifi dongles use a vendor specific class, so there is nothing to check in the descriptors
  // besides the id. the product string is the same thing firerouter greps for on install
  return WIFI_DONGLE_IDS.includes(id) || /802\.11|wi-?fi|wlan|wireless (adapter|lan|nic)/i.test(name);
}

// which types of USB accessories are plugged into the box. bluetooth and wifi dongles are
// reported with their id and product string, anything else is only counted as "other"
async function readUsbInfo() {
  const output = await exec("lsusb").then((result) => result.stdout).catch((err) => {
    if (!lsusbFailed) { // this is retried on every refresh, only complain about it once
      lsusbFailed = true;
      log.error("Failed to list USB devices", err.message);
    }
    return null;
  });
  // report nothing at all instead of "nothing detected" if the USB bus cannot be listed
  if (output === null)
    return null;
  lsusbFailed = false;

  const sysfs = await readUsbSysfs();
  const nativeIds = platform.getNativeUsbDeviceIds();
  const nicNames = platform.getAllNicNames();
  const info = {bluetooth: false, wifi: false, other: false, devices: []};
  for (const line of output.trim().split("\n")) {
    // e.g. "Bus 001 Device 004: ID 0bda:c820 Realtek Semiconductor Corp. 802.11ac NIC"
    const match = line.match(/^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-f]{4}:[0-9a-f]{4})\s*(.*)$/i);
    if (!match)
      continue;
    const [, bus, dev, rawId, rawName] = match;
    const id = rawId.toLowerCase();
    const name = rawName.trim();
    const device = sysfs[`${Number(bus)}-${Number(dev)}`] || {interfaces: [], netdevs: []};
    if (isUsbHub(id, name, device) || await isNativeUsbDevice(id, device, nativeIds, nicNames))
      continue;
    const types = [];
    // a combo dongle provides both functions on a single USB device, it counts as both
    if (isUsbBluetooth(id, name, device))
      types.push("bluetooth");
    if (await isUsbWifi(id, name, device))
      types.push("wifi");
    if (!types.length)
      types.push("other");
    for (const type of types)
      info[type] = true;
    info.devices.push({id, name, types});
  }
  log.verbose("[getUsbInfo] results", info);
  return info;
}

async function getUsbInfo() {
  if (usbInfoTs && Date.now() - usbInfoTs < USB_INFO_TTL)
    return usbInfo;
  if (!usbInfoPromise) // getSysInfo() can be called concurrently, refresh only once
    usbInfoPromise = readUsbInfo().catch((err) => {
      log.error("Failed to get USB info", err);
      return null;
    }).then((info) => {
      usbInfo = info;
      usbInfoTs = Date.now();
      usbInfoPromise = null;
      return info;
    });
  return usbInfoPromise;
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
      log.debug(`diskstats: device ${dev}, current sectors ${currentSectors}, boot baseline ${bootSectors}, saved cumulative ${savedSectors}, delta ${delta}, total ${deviceSectors[dev]}`);
    }

    // write today's daily snapshot
    const dayTs = Math.floor(now / 86400) * 86400;
    if (f.isMain()) {
      const todayExisting = await rclient.zrangebyscoreAsync(REDIS_DISKSTATS_DAILY_KEY, dayTs, dayTs);
      // store sector counts as strings to preserve 64-bit precision
      const devicesForRedis = {};
      for (const [dev, sectors] of Object.entries(deviceSectors)) {
        devicesForRedis[dev] = sectors.toString();
      }
      if (todayExisting && todayExisting.length > 0) {
        await rclient.zremAsync(REDIS_DISKSTATS_DAILY_KEY, todayExisting[0]);
      }
      await rclient.zaddAsync(REDIS_DISKSTATS_DAILY_KEY, dayTs, JSON.stringify({ t: dayTs, devices: devicesForRedis }));
      await rclient.zremrangebyrankAsync(REDIS_DISKSTATS_DAILY_KEY, 0, -(366 + 1)); // keep last 366 days
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
      log.debug(`diskstats: no entry from 365 days ago (ts ${day365AgoTs}), use (current - oldest)/days * 365 as estimate`);
      const oldestEntries = await rclient.zrangeAsync(REDIS_DISKSTATS_DAILY_KEY, 0, 0);
      if (oldestEntries && oldestEntries.length > 0) {
        const oldest = JSON.parse(oldestEntries[0]);
        if (oldest.t === dayTs) {
          log.debug(`diskstats: oldest entry is from today, not enough history data to make yearly estimate`);
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
  getEthErrorStats,
  getUsbInfo,
};
