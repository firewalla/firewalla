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
}, tick * 1000);

setInterval(()=>{
    flowMonitor.run("detect",60);
}, 60*1000);
