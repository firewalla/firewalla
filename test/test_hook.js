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

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;

let NewDeviceHook = require('../hook/NewDeviceHook.js');

let hook = new NewDeviceHook();
hook.run();

let sem = require('../sensor/SensorEventManager.js').getInstance();

sem.emitEvent({
  type: "NewDeviceWithMacOnly",
  mac: "02:42:81:82:F3:FB",
  name: "a good name",
  message: "track1"
});

sem.emitEvent({
  type: "NewDeviceWithIPOnly",
  ipv4Addr: "172.17.0.1",
  name: "a better name",
  message: "track2"
});

setTimeout(() => {
sem.emitEvent({
  type: "NewDevice",
  ipv4Addr: "172.17.0.2",
  name: "a solid name",
  message: "track3",
  mac: "f4:0f:24:34:72:ff",
});
}, 5000);

setTimeout(() => {
  process.exit(0);
}, 15000);
