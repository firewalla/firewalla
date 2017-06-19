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
let log = require("../net2/logger.js")(__filename, "info");

var bone = require("../lib/Bone.js");
var config = JSON.parse(require('fs').readFileSync('../net2/config.json', 'utf8'));
log.info("================================================================================");
log.info("Monitor Starting:",config.version);
log.info("================================================================================");

// api/main/monitor all depends on sysManager configuration
let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager('info');

if(!bone.isAppConnected()) {
  log.info("Waiting for pairing from first app...");
}


run0();

function run0() {
  if (bone.cloudready()==true &&
      bone.isAppConnected() &&
   // this is to ensure sysManager is already initliazed when called in API code
      sysManager.isConfigInitialized()) {
    run();
  } else {
    setTimeout(()=>{
      sysManager.update(null);
      run0();
    },1000);
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
        process.exit(1);
    },1000*2);
});

function run() {

let tick = 60 * 15; // waking up every 5 min
let monitorWindow = 60 * 60 * 4; // eight hours window

let FlowMonitor = require('./FlowMonitor.js');
let flowMonitor = new FlowMonitor(tick, monitorWindow, 'info');

log.info("================================================================================");
log.info("Monitor Running ");
log.info("================================================================================");

flowMonitor.run();
setInterval(() => {
    flowMonitor.run("dlp",tick);
    try {
      if (global.gc) {
       global.gc();
      }
    } catch(e) {
    }
}, tick * 1000);

setInterval(()=>{
    flowMonitor.run("detect",60);
    try {
      if (global.gc) {
       global.gc();
      }
    } catch(e) {
    }
}, 60*1000);

}
