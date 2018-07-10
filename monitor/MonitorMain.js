/*    Copyright 2016 Firewalla LLC 
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

let log = require("../net2/logger.js")(__filename, "info");

const sem = require('../sensor/SensorEventManager.js').getInstance();

var bone = require("../lib/Bone.js");
var config = JSON.parse(require('fs').readFileSync('../net2/config.json', 'utf8'));

const fs = require('fs');

log.info("================================================================================");
log.info("Monitor Starting:",config.version);
log.info("================================================================================");

// api/main/monitor all depends on sysManager configuration
let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager('info');

if(!bone.isAppConnected()) {
  log.info("Waiting for pairing from first app...");
}

// load feature toggle on/off from redis to memory
require('../net2/config.js').syncDynamicFeaturesConfigs()

run0();

function run0() {
  if (bone.cloudready()==true &&
      bone.isAppConnected() &&
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
    bone.log("error",{version:config.version,type:'FIREWALLA.MON.exception',msg:err.message,stack:err.stack},null);
    setTimeout(()=>{
        try {
            require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
        } catch(e) {
        }
        process.exit(1);
    },1000*2);
});

process.on('unhandledRejection', (reason, p)=>{
  let msg = "Possibly Unhandled Rejection at: Promise " + p + " reason: "+ reason;
  log.warn('###### Unhandled Rejection',msg,reason.stack,{});
  bone.log("error",{version:config.version,type:'FIREWALLA.MON.unhandledRejection',msg:msg,stack:reason.stack},null);
  // setTimeout(()=>{
  //   require('child_process').execSync("touch /home/pi/.firewalla/managed_reboot")
  //   process.exit(1);
  // },1000*2);
});

let heapSensor = null;

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

function run() {
  const firewallaConfig = require('../net2/config.js').getConfig();
  sysManager.setConfig(firewallaConfig) // update sys config when start
  
  sysManager = null; // not needed any more after run()
  
  // listen on request to dump heap for this process, used for memory optmiziation
  // let HeapSensor = require('../sensor/HeapSensor');
  // heapSensor = new HeapSensor();
  // heapSensor.run();
  
  const tick = 60 * 15; // waking up every 15 min
  const monitorWindow = 60 * 60 * 4; // eight hours window
  
  const FlowMonitor = require('./FlowMonitor.js');
  const flowMonitor = new FlowMonitor(tick, monitorWindow, 'info');
  
  log.info("================================================================================");
  log.info("Monitor Running ");
  log.info("================================================================================");
  
  flowMonitor.run();
  
  setInterval(() => {
    const type = 'dlp';
    const _status = status[type];
    
    updateTouchFile();

    setTimeout(() => {
      if (_status.running && _status.runBy !== 'signal') {
        log.error("DLP Timeout", status);
        throw new Error("Monitor DLP Timeout");
      } else {
        log.info("Last DLP Ran Successful");
      }
    }, tick / 2 * 1000);

    if (_status.running) {
      log.warn('Already a dlp session running by signal trigger, skip this time', status);
      return;
    }

    setStatus(_status, {running: true, runBy: 'scheduler'});
    flowMonitor.run(type, tick, () => {
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    });
  }, tick * 1000);

  setInterval(() => {
    const type = 'detect';
    const _status = status[type];

    updateTouchFile();

    setTimeout(() => {
      if (_status.running && _status.runBy !== 'signal') {
        log.error("Last Detection Timeout", status);
        throw new Error("Monitor Detect Timeout");
      } else {
        log.info("Last Detect Ran Successful");
      }
    }, 55 * 1000);

    if (_status.running) {
      log.warn('Already a detect session running by signal trigger, skip this time', status);
      return;
    }
    
    setStatus(_status, {running: true, runBy: 'scheduler'});
    flowMonitor.run(type, 60, () => {
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    });
  }, 60 * 1000);

  process.on('SIGUSR1', () => {
    log.info('Received SIGUSR1. Trigger DLP check.');
    const type = 'dlp';
    const _status = status[type];
    
    if (_status.running) {
      log.warn("DLP check is already running, skip firing", status);
      return;
    }
    setStatus(_status, {running: true, runBy: 'signal'});
    flowMonitor.run(type, tick, () => {
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
    flowMonitor.run(type, 60, () => {
      log.info('Clean up after', type, 'run');
      setStatus(_status, {running: false, runBy: ''});
      gc();
    });
  });

}

sem.on("ChangeLogLevel", (event) => {
  if(event.name && event.level) {
    require('../net2/LoggerManager.js').setLogLevel(event.name, event.level);
  }
});