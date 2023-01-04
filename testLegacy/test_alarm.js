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

var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

let util = require('util');

let date = new Date() / 1000;
let a = new Alarm.VideoAlarm(date, "10.0.1.25", "VIDEO-1", {"p.device.name": "My Macbook"});
a["p.device.id"] = "1";
//let a = alarmManager2.createVideoAlarm(date, "10.0.1.25", {destination_domain: "pornhub.com", device_name: "My Macbook"});
alarmManager2.saveAlarm(a, (err) => {
  expect(err).to.be.null;
});

log.info(a.toString());
log.info(a.localizedMessage());
expect(alarmManager2.validateAlarm(a)).to.be.true;

let a2 = new Alarm.GameAlarm(date, "10.0.1.25", "SuperCell", {"p.device.name": "My Macbook2"});
a2["p.device.id"] = "1";
log.info(a2.localizedMessage());

let a3 = new Alarm.PornAlarm(date, "10.0.1.26", "Pornhub.com", {"p.device.name": "My Macbook3"});
a3["p.device.id"] = "1";
log.info(a3.localizedMessage());

let a4 = new Alarm.VideoAlarm(date, "10.0.1.27", "VIDEO-1", {"p.device.name": "My Macbook"});
a4["p.device.id"] = "1";

alarmManager2.checkAndSave(a3, (err) => {
  if(err) {
    console.log(a3);
  }
  expect(err).to.be.null;
})

var b = new Alarm.VideoAlarm(date, "10.0.1.25", "youku", {});
log.info(b);
log.info(b.localizedMessage());
expect(alarmManager2.validateAlarm(b)).to.be.false;

let ExceptionManager = require('../alarm/ExceptionManager.js');
let exceptionManager = new ExceptionManager();
let e1 = new Exception({"p.device.name": "My Macbook"});
exceptionManager.saveException(e1, (err) => {
  expect(err).to.be.null;
  
  exceptionManager.loadExceptions((err, results) => {
    expect(err).to.be.null;
    expect(results.length > 0).to.be.true;
    console.log(results);

    exceptionManager.match(a, (err, result) => {
      expect(result).to.be.true;
    });
    exceptionManager.match(a4, (err, result) => {
      expect(result).to.be.true;
    });

  });
});

console.log(">>>>" + util.inspect(e1));
console.log("<<<<" + a);
expect(e1.match(a)).to.be.true;
expect(e1.match(a4)).to.be.true;
expect(e1.match(a2)).to.be.false;

alarmManager2.loadActiveAlarms((err, alarms) => {
  expect(err).to.be.null;
  alarms.forEach((x) => console.log(x.aid + ">>>" + x.localizedMessage()));
});

expect(a instanceof Alarm.OutboundAlarm).to.be.true;

let a5 = new Alarm.VideoAlarm(date, "10.0.1.25", "VIDEO-1", {"p.device.name": "My Macbook"});
a5.setDestinationHostname("youtube.com");
a5.setDestinationName("youtube.com");
a5.setDestinationIPAddress("78.16.49.15");
a5["p.device.id"] = "1";

const il = require('../intel/IntelLoader.js');

let promise = il.enrichAlarm(a5);
promise.then((alarm) => {
  log.info(alarm.toString());
});

alarmManager2.loadActiveAlarms((err, results) => {
  results.forEach((x) => console.log(x));
});

let a6 = new Alarm.AbnormalUploadAlarm(date, "10.0.1.28", "140.206.133.90", {
  "p.device.id" : "m1",
  "p.device.name" : "Macbook Pro",
  "p.device.ip" : "10.0.1.28",
  "p.device.port" : 8848,
  "p.dest.ip": "140.206.133.90",
  "p.dest.port" : 443,
  "p.dest.name" : "www.xyzxyzxyz.com",
  "p.transfer.outbound.size" : 12345,
  "p.transfer.inbound.size" : 54321,
  "p.transfer.duration" : 16.86,
  "p.local_is_client": 1
});

  alarmManager2.checkAndSave(a6, (err) => {
    console.log(util.inspect(alarm));
    if(!err) {
    }
  });

// Test isDup

expect(a5.isDup(a6)).to.be.false;

let c1 = new Alarm.AbnormalUploadAlarm(date, "10.0.1.22", "DEST-1", {
  "p.device.mac": "XXX"
});

let c2 = new Alarm.AbnormalUploadAlarm(date, "10.0.1.22", "DEST-1", {
  "p.device.mac": "XXX"
});

let c3 = new Alarm.AbnormalUploadAlarm(date, "10.0.1.22", "DEST-1", {
  "p.device.mac": "YYY"
});

let c4 = new Alarm.VideoAlarm(date, "10.0.1.22", "DEST-1", {
  "p.device.mac": "XXX"
});

expect(c1.isDup(c2)).to.be.true;
expect(c1.isDup(c3)).to.be.false;
expect(c1.isDup(c4)).to.be.false;

// Test dedup

let random = Math.random();

let d1 = new Alarm.AbnormalUploadAlarm(date, "10.0.1.22", "DEST-1" + random, {
  "p.device.mac": "XXX",
  "p.device.name": "YYY",
  "p.device.id": "YYY",
  "p.dest.name": "DEST-1xx",
  "p.transfer.outbound.humansize": "100MB"
});

alarmManager2.dedup(d1).then((dedupResult) => {
  expect(dedupResult).to.be.false;

  alarmManager2.checkAndSave(d1, (err) => {
    expect(err).to.be.null;
    
    let d2 = new Alarm.AbnormalUploadAlarm(date, "10.0.1.22", "DEST-1" + random, {
      "p.device.mac": "XXX",
      "p.device.name": "YYY",
      "p.device.id": "YYY",
      "p.dest.name": "DEST-1xxx",
      "p.transfer.outbound.humansize": "101MB"
    });
    
    alarmManager2.dedup(d2).then((dedupResult2) => {
      expect(dedupResult2).to.be.true;

      alarmManager2.checkAndSave(d2, (err) => {
        expect(err).not.to.be.null;
      });
    });
  });
  
});

let intel1 = new Alarm.IntelAlarm(new Date() / 1000, "10.0.1.33", "major", {
  "p.device.ip": "10.0.1.33",
  "p.device.port": 8888,
  "p.dest.id": "111.111.111.111",
  "p.dest.ip": "111.111.111.111",
  "p.dest.name": "www.test.com",
  "p.dest.port": 8888,
  "p.security.reason": "test reason",
  "p.security.numOfReportSources": 100,
  "p.device.mac": "AA:AA:AA:BB:BB:BB",
  "p.device.name": "xxxxxxx",
  "p.device.id": "xxxxxxxx"
});

alarmManager2.checkAndSave(intel1, (err) => {
  expect(err).to.be.null;
})

setTimeout(() => process.exit(0), 10000);
