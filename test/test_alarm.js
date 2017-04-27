'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

let i18n = require('i18n');
i18n.configure({
  directory: __dirname + "/../locales",
  defaultLocale: 'zh'
});

let error = null;
let date = new Date() / 1000;
let a = new Alarm.VideoAlarm(date, "10.0.1.25", "VIDEO-1", {device_name: "My Macbook"});
//let a = alarmManager2.createVideoAlarm(date, "10.0.1.25", {destination_domain: "pornhub.com", device_name: "My Macbook"});
alarmManager2.saveAlarm(a, (err) => {
  expect(err).to.be.null;
});

log.info(a.toString());
log.info(a.localizedMessage());

let a2 = new Alarm.GameAlarm(date, "10.0.1.25", "SuperCell", {device_name: "My Macbook2"});
log.info(a2.localizedMessage());

let a3 = new Alarm.PornAlarm(date, "10.0.1.26", "Pornhub.com", {device_name: "My Macbook3"});
log.info(a3.localizedMessage());

let a4 = new Alarm.VideoAlarm(date, "10.0.1.27", "VIDEO-1", {device_name: "My Macbook"});

alarmManager2.checkAndSave(a3, (err) => {
  expect(err).to.be.null;
})

var b;

try {
  b = new Alarm.VideoAlarm(date, "10.0.1.25", "youku", {});
  log.info(b);
  log.info(b.localizedMessage());
} catch (e) {
  // should be able to catch it
  error = e;
}

expect(error).not.to.be.null;

let exception = require('../Alarm/Exception.js');
let ExceptionManager = require('../Alarm/ExceptionManager.js');
let exceptionManager = new ExceptionManager();
let e1 = new Exception({device_name: "My Macbook"});
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

expect(e1.match(a)).to.be.true;
expect(e1.match(a4)).to.be.true;
expect(e1.match(a2)).to.be.false;

alarmManager2.loadActiveAlarms((err, alarms) => {
  expect(err).to.be.null;
  alarms.forEach((x) => console.log(x.aid + ">>>" + x.localizedMessage()));
});

setTimeout(() => process.exit(0), 3000);
