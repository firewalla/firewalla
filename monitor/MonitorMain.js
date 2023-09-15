/*    Copyright 2016-2022 Firewalla Inc.
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
process.title = 'FireMon';
require('events').EventEmitter.prototype._maxListeners = 100;

const log = require("../net2/logger.js")(__filename, "info");
const config = require('../net2/config.js').getConfig();

log.info("================================================================================");
log.info("Monitor Starting:",config.version);
log.info("================================================================================");

const fc = require("../net2/config.js");

// init FireRouter ASAP
const fireRouter = require('../net2/FireRouter.js')

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require("../lib/Bone.js");

const fs = require('fs');
const { timeout } = require('../util/asyncNative.js')

// api/main/monitor all depends on sysManager configuration
const sysManager = require('../net2/SysManager.js');

if(!bone.isAppConnected()) {
  log.info("Waiting for pairing from first app...");
}

run0();

async function run0() {
  await sysManager.waitTillInitialized();
  if (bone.cloudready()==true &&
      bone.isAppConnected() &&
      fireRouter.isReady() &&
      // this is to ensure sysManager is already initliazed when called in API code
      sysManager.isConfigInitialized()) {
    run();
  } else {
    log.forceInfo("Waiting for first app to connect...");
    setTimeout(()=>{
      sysManager.update(null);
      run0();
    },3000);
  }
}

process.on('uncaughtException',(err)=>{
  log.info("################### CRASH #############");
  log.info("+-+-+-",err.message,err.stack);
  if (err && err.message && err.message.includes("Redis connection")) {
    return;
  }
  bone.logAsync("error", {
    type: 'FIREWALLA.MON.exception',
    msg: err.message,
    stack: err.stack,
    err: err
  });
  setTimeout(()=>{
    try {
      require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
    } catch(e) {
    }
    process.exit(1);
  },1000*2);
});

process.on('unhandledRejection', (reason, p)=>{
  const msg = 'Unhandled Rejection: ' + reason;
  log.error('###### Unhandled Rejection:', reason);
  if (msg.includes("Redis connection"))
    return;
  bone.logAsync("error", {
    type: 'FIREWALLA.MON.unhandledRejection',
    msg: msg,
    stack: reason.stack,
    err: reason
  });
});

function gc() {
  try {
    if (global.gc) {
      global.gc();
    }
  } catch (err) {
  }
}

let status = {
  dlp: {
    running: false,
    runBy: ''
  },
  detect: {
    running: false,
    runBy: ''
  }
};

function setStatus(type, opts) {
  Object.assign(type, opts);
}

function updateTouchFile() {
  const monitorTouchFile = "/dev/shm/monitor.touch";

  fs.open(monitorTouchFile, 'w', (err, fd) => {
    if(!err) {
      fs.close(fd, (err2) => {

      })
    }
  })
}

let cachedSingleDetect = {};

async function scheduleSingleDetectRequset(flowMonitor, options) {
  const type = 'detect';
  const _status = status[type];
  const mac = options.mac;

  if(!mac) {
    return;
  }

  // do not run twice per session
  if(cachedSingleDetect[mac]) {
    log.info("Skipped since just triggered on this mac recently:",mac);
    return;
  }

  cachedSingleDetect[mac] = 1;

  if(_status.running) {
    if(options.ttl > 0) {
      options.ttl--;
      setTimeout(() => {
        log.info("firemon is busy, rescheduling detect request in 3 seconds:",mac);
        scheduleSingleDetectRequset(flowMonitor, options);
      }, 3 * 1000);
    } else {
      log.forceInfo("Schedule TTL timeout for single detect request on mac:", mac);
    }
  } else {
    log.info("Got a single request to check mac address:", mac);
    setStatus(_status, {running: true, runBy: 'scheduler'});
    await flowMonitor.run(type, 60, {mac}).catch((err) => {
      log.error("Got error when run flow monitor on mac:",mac, "error:", err);
    });
    log.info("Completed a single request to check mac address:", mac);
    setStatus(_status, {running: false, runBy: ''});
    gc();
  }
}

function scheduleRunDetect(flowMonitor) {
  setInterval(() => {
    const type = 'detect';
    const _status = status[type];

    updateTouchFile();

    if (_status.running) {
      log.warn('Already a detect session running by signal trigger, skip this time', status);
      return;
    }

    setStatus(_status, {running: true, runBy: 'scheduler'});
    timeout(flowMonitor.run(type, 60), 55).then(() => {
      cachedSingleDetect = {}; // clean cache
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    }).catch(err => {
      log.error('DLP failed', err, status)
    })
  }, 60 * 1000);

  sem.on("FW_DETECT_REQUEST", (event) => {
    if(!event.mac) {
      return;
    }

    scheduleSingleDetectRequset(flowMonitor, {
      mac: event.mac,
      ttl: 10,
    });
  });
}

function scheduleRunDLP(flowMonitor) {
  const tick = 60 * 15; // waking up every 15 min

  setInterval(() => {
    const type = 'dlp';
    const _status = status[type];

    updateTouchFile();

    if (_status.running) {
      log.warn('Already a dlp session running by signal trigger, skip this time', status);
      return;
    }

    setStatus(_status, {running: true, runBy: 'scheduler'});
    timeout(flowMonitor.run(type, tick), tick / 2).then(() => {
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    }).catch(err => {
      log.error('DLP failed', err, status)
    })
  }, tick * 1000);
}

function run() {
  // listen on request to dump heap for this process, used for memory optmiziation
  // let HeapSensor = require('../sensor/HeapSensor');
  // heapSensor = new HeapSensor();
  // heapSensor.run();

  const tick = 60 * 15; // waking up every 15 min
  const monitorWindow = 60 * 60 * 4; // 4 hours window

  const FlowMonitor = require('./FlowMonitor.js');
  const flowMonitor = new FlowMonitor(tick, monitorWindow);

  log.info("================================================================================");
  log.info("Monitor Running ");
  log.info("================================================================================");

  scheduleRunDLP(flowMonitor);

  scheduleRunDetect(flowMonitor);

  process.on('SIGUSR1', () => {
    log.info('Received SIGUSR1. Trigger DLP check.');
    const type = 'dlp';
    const _status = status[type];

    if (_status.running) {
      log.warn("DLP check is already running, skip firing", status);
      return;
    }
    setStatus(_status, {running: true, runBy: 'signal'});
    flowMonitor.run(type, tick).then(() => {
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    });
  });

  process.on('SIGUSR2', () => {
    log.info('Received SIGUSR2. Trigger Detect check.');
    const type = 'detect';
    const _status = status[type];

    if (_status.running) {
      log.warn("Detect check is already running, skip firing", status);
      return;
    }
    setStatus(_status, {running: true, runBy: 'signal'});
    flowMonitor.run(type, 60).then(() => {
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    });
  });

}

sem.on("ChangeLogLevel", (event) => {
  if(event.name && event.level) {
    if(event.name === "*") {
      require('../net2/LoggerManager.js').setGlobalLogLevel(event.level);
    } else {
      require('../net2/LoggerManager.js').setLogLevel(event.name, event.level);
    }
  }
});
