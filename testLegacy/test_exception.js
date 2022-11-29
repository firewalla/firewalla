/*    Copyright 2020 Firewalla LLC 
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

var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

let util = require('util');

let date = new Date() / 1000;

let ExceptionManager = require('../alarm/ExceptionManager.js');
let exceptionManager = new ExceptionManager();

// (async() => {
//     await exceptionManager.deleteException(16);
// })();

let c1 = { "$lt": 101521 };
let dest_ip = "180.101.53.2";
let device_ip = "192.168.219.102";
let e1 = new Exception({ "if.type": "ip", "if.target": dest_ip, "p.device.ip": device_ip, "json.p.transfer.outbound.size": true, "p.transfer.outbound.size": JSON.stringify(c1) });
exceptionManager.saveException(e1, (err) => {
    expect(err).to.be.null;
});

let a = new Alarm.AbnormalUploadAlarm(date, device_ip, dest_ip, {
    "p.device.id" : "38:E6:0A:AD:38:E2",
    "p.device.name" : "Test Device",
    "p.device.ip" : device_ip,
    "p.device.port" : [49380],
    "p.dest.ip": dest_ip,
    "p.dest.port" : 443,
    "p.dest.name" : "ct-bjs-sgh-00001.oos-cn-180622.ctyunapi.cn",
    "p.transfer.outbound.size" : 101520,
    "p.transfer.inbound.size" : 10734,
    "p.transfer.duration" : 3485.2434260845184,
    "p.local_is_client": 1
});

alarmManager2.checkAndSave(a, (err, alarm) => {
    console.log(util.inspect(alarm));
    console.log(err);
});

setTimeout(() => process.exit(0), 10000);
