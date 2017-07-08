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

let log = require('../net2/logger.js')(__filename);

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;

let sem = require('../sensor/SensorEventManager').getInstance();

let Promise = require('bluebird');

let hl = require('../hook/HookLoader');
hl.initHooks();
hl.run();

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

let h1 = "172.17.0.12";
let m1 = "F4:0F:24:AA:AA:04";

let h2 = "172.17.0.13";
let m2 = "F4:0F:24:AA:AA:05";

let h3 = "172.17.0.14";
let m3 = "F4:0F:24:AA:AA:06";


Promise.all([
hostTool.deleteHost(h1),
hostTool.deleteMac(m1),
hostTool.deleteHost(h2),
hostTool.deleteMac(m2),
  ]).then(() => {
  log.info("init done");
});


setTimeout(() => {
  sem.emitEvent({
    type: "DeviceUpdate",
    message: "testcase: should be a pure new device",
    host:
      {
        ipv4:h1,
        ipv4Addr: h1,
        bname: "test1",
        mac: m1
      }
  });

  sem.emitEvent({
    type: "DeviceUpdate",
    message: "testcase: should be a pure new device",
    host:
      {
        ipv4:h3,
        ipv4Addr: h3,
        bname: "test3",
        mac: m3
      }
  });
}, 5000);

setTimeout(() => {
  sem.emitEvent({
    type: "DeviceUpdate",
    message: "testcase: should be just replacing ip address",
    host:
      {
        ipv4:h2,
        ipv4Addr: h2,
        bname: "test1",
        mac: m1
      }
  });
}, 7000);

setTimeout(() => {
  sem.emitEvent({
    type: "DeviceUpdate",
    message: "testcase: device took over another device's ip",
    host:
      {
        ipv4:h3,
        ipv4Addr: h3,
        bname: "test1",
        mac: m1
      }
  });
}, 10 * 1000);


setTimeout(() => {
  sem.emitEvent({
    type: "DeviceUpdate",
    message: "testcase: regular device update",
    host:
      {
        ipv4:h3,
        ipv4Addr: h3,
        bname: "test1",
        mac: m1
      }
  });
}, 13 * 1000);


setTimeout(() => {
  process.exit(0);
}, 15* 1000);