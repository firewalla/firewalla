/*    Copyright 2016 Rottiesoft LLC 
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

var bone = require("../lib/Bone.js");
console.log("================================================================================");
console.log("Monitor Starting");
console.log("================================================================================");

run0();

function run0() {
    if (bone.cloudready()==true) {
        run();
    } else {
        setTimeout(()=>{
            run0();
        },1000);
    }
}


function run() {

let tick = 60 * 15; // waking up every 5 min
let monitorWindow = 60 * 60 * 8; // eight hours window

let FlowMonitor = require('./FlowMonitor.js');
let flowMonitor = new FlowMonitor(tick, monitorWindow, 'info');

console.log("================================================================================");
console.log("Monitor Running ");
console.log("================================================================================");

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
