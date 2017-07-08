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

var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

let util = require('util');

let ip = "172.17.0.2";
let vid = "XXXX-1";
let title = "title1";
let state = "VULNERABLE";
let disclosure = "2017-07-01";
let sid = "xxxx-1";

let a1 = new Alarm.VulnerabilityAlarm(new Date() / 1000, ip, vid, {
  "p.device.ip": ip,
  "p.vuln.key": vid,
  "p.vuln.title": title,
  "p.vuln.state": state,
  "p.vuln.discolure": disclosure,
  "p.vuln.scriptID": sid
});

alarmManager2.enrichDeviceInfo(a1)
.then(() => alarmManager2.checkAndSaveAsync(a1)
  .then(() => {
  console.log("success");
}).catch((err) => {
  expect(err).to.equal(undefined);
  })).catch((err) => {
  expect(err).to.equal(undefined);
});

setTimeout(() => {}, 10000);