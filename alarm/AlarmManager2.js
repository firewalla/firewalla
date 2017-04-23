'use strict';

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('./Alarm.js');

let redis = require('redis');
let rclient = redis.createClient();

let instance = null;

let alarm_key = "alarm";
let ExceptionManager = require('./ExceptionManager.js');
let exceptionManager = new ExceptionManager();

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  saveAlarm(alarm, callback) {
    callback = callback || function() {}
    
    let str = JSON.stringify(alarm);
    let score = alarm.timestamp / 1000;
    rclient.zadd(alarm_key, score, str, (err) => {
      if(err) {
        log.error("Failed to save alarm: " + err);
      }
      callback(err);
    });
  }

  checkAndSave(alarm, callback) {
    callback = callback || function() {}

    exceptionManager.match(alarm, (err, result) => {
      if(err) {
        callback(err);
        return;
      }

      if(result) {
        callback(new Error("exception covered"));
        return;
      }

      this.saveAlarm(alarm, callback);

    });
  }
}


