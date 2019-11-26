/*    Copyright 2016 - 2019 Firewalla INC 
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

let PolicyManager2 = require('../alarm/PolicyManager2.js');
let pm2 = new PolicyManager2();

let Policy = require('../alarm/Policy.js');

let util = require('util');

let p1 = new Policy("dns", "www.test4.com", {
  
});

pm2.savePolicyAsync(p1)
  .then(() => {
  return pm2.disableAndDeletePolicy(p1.pid).then(() => {
    console.log("success");  
  })
});

setTimeout(() => {}, 10000);