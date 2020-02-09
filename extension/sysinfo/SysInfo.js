/*    Copyright 2019 Firewalla INC
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

const df = require('node-df');

const os = require('../../vendor_lib/osutils.js');

const exec = require('child-process-promise').exec;

const rclient = require('../../util/redis_manager.js').getRedisClient()

const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const rateLimit = require('../../extension/ratelimit/RateLimit.js');

const fs = require('fs');

let cpuUsage = 0;
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

let updateInterval = 120 * 1000; // every 2 minutes

let threadInfo = {};

let diskInfo = null;

let intelQueueSize = 0;

let multiProfileSupport = false;

let no_auto_upgrade = false;

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
  ])

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

async function getRateLimitInfo() {
  rateLimitInfo = await rateLimit.getLastTS();
}

function getDiskInfo() {
  return new Promise((resolve, reject) => {
    df((err, response) => {
      if (err || !response) {
        log.error("Failed to get disk info", err);
        resolve();
        return
      }

      const disks = response.filter((entry) => {
        return entry.filesystem.startsWith("/dev/mmc");
      })

      diskInfo = disks;

      resolve();
    });
  })
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
    curTemp = platform.getCpuTemperature();
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
    const output = require('child_process').execSync(`${f.getFirewallaHome()}/scripts/category_blocking_stats.sh`, {encoding: 'utf8'})
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

function getSysInfo() {
  let sysinfo = {
    cpu: cpuUsage,
    mem: 1 - os.freememPercentage(),
    realMem: realMemUsage,
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
    diskInfo: diskInfo,
    categoryStats: getCategoryStats(),
    multiProfileSupport: multiProfileSupport,
    no_auto_upgrade: no_auto_upgrade
  }

  if(rateLimitInfo) {
    sysinfo.rateLimitInfo = rateLimitInfo;
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
  return require('child_process').execSync("top -b -n 1 -o %MEM | head -n 20").toString('utf-8').split("\n");
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

function getSystemInfo() {
  return "a good test"
}

module.exports = {
  getSysInfo: getSysInfo,
  startUpdating: startUpdating,
  stopUpdating: stopUpdating,
  getRealMemoryUsage:getRealMemoryUsage,
  getRecentLogs: getRecentLogs,
  getPerfStats: getPerfStats,
  getHeapDump: getHeapDump,
  getSystemInfo: getSystemInfo
};
