/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let log = require("../../net2/logger.js")(__filename, "info");

let fs = require('fs');
let util = require('util');

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();
let logFolder = f.getLogFolder();

let config = require("../../net2/config.js").getConfig();

let userID = f.getUserID();

//let SysManager = require('../../net2/SysManager');
//let sysManager = new SysManager();

let os  = require('os-utils');

let redis = require('redis');
let rclient = redis.createClient();
let async = require('async');

var cpuUsage = 0;
let memUsage = 0;
let realMemUsage = 0;
let usedMem = 0;
let allMem = 0;
let curTemp = 0;
let peakTemp = 0;

let conn = 0;
let peakConn = 0;

let redisMemory = 0;

let updateFlag = 0;

let updateInterval = 30 * 1000; // every 30 seconds

let releaseBranch = null;

function update() {
  os.cpuUsage((v) => {
    log.debug( 'CPU Usage (%): ' + v );
    cpuUsage = v;
  });

  getRealMemoryUsage();
  getTemp();
  getConns();
  getRedisMemoryUsage();

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

function getRealMemoryUsage() {
  let spawn = require('child_process').spawn;
  let prc = spawn('free',  []);
  
  prc.stdout.setEncoding('utf8');
  prc.stdout.on('data', function (data) {
    var str = data.toString()
    var lines = str.split(/\n/g);
    for(var i = 0; i < lines.length; i++) {
      lines[i] = lines[i].split(/\s+/);
    }

    usedMem = parseInt(lines[1][2]);
    allMem = parseInt(lines[1][1]);
    realMemUsage = 1.0 * usedMem / allMem;
    log.debug("Memory Usage: ", usedMem, " ", allMem, " ", realMemUsage);    
  });
}

function getTemp() {
  let tempFile = "/sys/class/thermal/thermal_zone0/temp";
  fs.readFile(tempFile, (err, data) => {
    if(err) {
      log.debug("Temperature is not supported");
      curTemp = -1;
    } else {
      curTemp = parseInt(data);
      log.debug("Current Temp: ", curTemp);
      peakTemp = peakTemp > curTemp ? peakTemp : curTemp;
    }
  });
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

function getConns() {
  // get conns in last 24 hours
  rclient.keys('flow:conn:*', (err, keys) => {
    if(err) {
      conn = -1;
      return;
    }

    let countConns = function(key, callback) {
      rclient.zcount(key, '-inf', '+inf', callback);
    }
    
    async.map(keys, countConns, (err, results) => {
      if(results.length > 0) {
        conn = results.reduce((a,b) => (a+b));
        peakConn = peakConn > conn ? peakConn : conn;
      }
    });

  });
}

function getRedisMemoryUsage() {
  let cmd = "redis-cli info | grep used_memory: | awk -F: '{print $2}'";
  require('child_process').exec(cmd, (err, stdout, stderr) => {
    if(!err) {
      redisMemory = stdout.replace(/\r?\n$/,'');
    }
  });
}

function getReleaseType() {
  if(!releaseBranch) {
    releaseBranch = require('child_process').execSync('git rev-parse --abbrev-ref HEAD').toString('utf-8');
  }

  if(releaseBranch.includes("master")) {
    return "dev";
  } else if(releaseBranch.includes("release")) {
    return "prod";
  } else if(releaseBranch.includes("staging")) {
    return "beta";
  } else {
    return "unknown";
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
    releaseType: getReleaseType()
  }

  return sysinfo;
}

function getRecentLogs(callback) {
  let logFiles = ["api.log", "kickui.log", "main.log", "monitor.log", "dns.log"].map((name) => logFolder + "/" + name);

  let tailNum = config.sysInfo.tailNum || 100; // default 100
  let tailFunction = function(file, callback) {
    let cmd = util.format('tail -n %d %s', tailNum, file);
    require('child_process').exec(cmd, (code, stdout, stderr) => {
      if(code) {
        log.warn("error when reading file " + file + ": " + stderr);
        callback(null, { file: file, content: "" });
      } else {
        callback(null, { file: file, content: stdout } );
      }
    });
  }
  
  async.map(logFiles, tailFunction, callback);
}

function getTopStats() {
  return require('child_process').execSync("top -b -n 1 -o %MEM | head -n 20").toString('utf-8');
}

function getTop5Flows(callback) {
  rclient.keys("flow:conn:*", (err, results) => {
    if(err) {
      callback(err);
      return;
    }
    
    async.map(results, (flow, callback) => {
      rclient.zcount(flow, "-inf", "+inf", (err, count) => {
        if(err) {
          callback(err);
          return;
        }
        callback(null, {name: flow, count: count});
      });
    }, (err, results) => {
      async.sortBy(results, (x, callback) => callback(null, x.count * -1), (err, results) => {
        callback(null, results.slice(0, 5));
      });
    });
  });
}

function getPerfStats(callback) {
  getTop5Flows((err, results) => {
    callback(err, {
      top: getTopStats(),
      sys: getSysInfo(),
      perf: results
    });
  });
}

module.exports = {
  getSysInfo: getSysInfo,
  startUpdating: startUpdating,
  stopUpdating: stopUpdating,
  getRealMemoryUsage:getRealMemoryUsage,
  getRecentLogs: getRecentLogs,
  getPerfStats: getPerfStats
};
