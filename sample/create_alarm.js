#!/usr/bin/env node
'use strict'

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('../alarm/Alarm.js');
let Exception = require('../alarm/Exception.js');
let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

let a = new Alarm.VideoAlarm(new Date() / 1000, "My Macbook Pro", "youku.com", {
  "p.device.name": "My MacBook Pro",
  "p.dest.name": "Coursera.org",
  "p.dest.ip": "54.239.130.241"
});

let a2 = new Alarm.NewDeviceAlarm(new Date() / 1000, "iPad-1", {
  "p.device.name": "iPad-1",
  "p.device.ip": "192.168.2.22",
  "p.device.mac": "XX:YY:ZZ:AA:BB:CC:DD:EE",
  "p.device.vendor": "Apple Inc."
});

// 24.565462, -81.779364
//  "p.dest.name": "Youku.com",
//  "p.dest.ip": "106.11.186.1"
// 54.239.130.241

[a].forEach((alarm) => {
  alarmManager2.enrichDestInfo(alarm).then((alarm) => {
    alarmManager2.checkAndSave(alarm, (err) => {
      if(err) {
        log.error("Failed to save alarm: " + a);
      }
    });
  });
});

alarmManager2.checkAndSave(a2, (err) => {
  if(err)
    log.error("Failed to save alarm: " + err);
});


setTimeout(() => process.exit(0), 3000);
