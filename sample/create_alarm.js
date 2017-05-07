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

// 24.565462, -81.779364
//  "p.dest.name": "Youku.com",
//  "p.dest.ip": "106.11.186.1"
// 54.239.130.241
alarmManager2.enrichOutboundAlarm(a).then((alarm) => {
  alarmManager2.checkAndSave(alarm, (err) => {
    if(err) {
      log.error("Failed to save alarm: " + a);
      process.exit(1);
    }
    process.exit(0);
  });
});

