'use strict';

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('./Alarm.js');

let redis = require('redis');
let rclient = redis.createClient();

let flat = require('flat');

let audit = require('../util/audit.js');
let util = require('util');

let Promise = require('promise');

let IM = require('../net2/IntelManager.js')
let im = new IM('info');

let instance = null;

let alarmActiveKey = "alarm_active";
let ExceptionManager = require('./ExceptionManager.js');
let exceptionManager = new ExceptionManager();

let alarmIDKey = "alarm:id";
let alarmPrefix = "_alarm:";
let initID = 1;

let c = require('../net2/MessageBus.js');

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
      this.publisher = new c('info');
    }
    return instance;
  }

  createAlarmIDKey(callback) {
    rclient.set(alarmIDKey, initID, callback);
  }

  getNextID(callback) {
    rclient.get(alarmIDKey, (err, result) => {
      if(err) {
        log.error("Failed to get alarmIDKey: " + err);
        callback(err);
        return;
      }

      if(result) {
        rclient.incr(alarmIDKey, (err) => {
          if(err) {
            log.error("Failed to incr alarmIDKey: " + err);
          }
          callback(null, result);
        });
      } else {
        this.createAlarmIDKey((err) => {
          if(err) {
            log.error("Failed to create alarmIDKey: " + err);
            callback(err);
            return;
          }

          rclient.incr(alarmIDKey, (err) => {
            if(err) {
              log.error("Failed to incr alarmIDKey: " + err);
            }
            callback(null, initID);
          });
        });
      }
    });
  }

  addToActiveQueue(alarm, callback) {
    //TODO
    let score = alarm.timestamp / 1000;
    let id = alarm.aid;
    rclient.zadd(alarmActiveKey, score, id, (err) => {
      if(err) {
        log.error("Failed to add alarm to active queue: " + err);
      }
      callback(err);
    });
  }

  validateAlarm(alarm) {
    let keys = alarm.requiredKeys();
    for(var i = 0; i < keys.length; i++) {
      let k = keys[i];
      if(!alarm[k]) {
        log.error("Invalid payload for " + this.type + ", missing " + k);
        return false;
      }
    }
    return true;
  }
  
  saveAlarm(alarm, callback) {
    callback = callback || function() {}

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      alarm.aid = id;

      let alarmKey = alarmPrefix + id;

      rclient.hmset(alarmKey, flat.flatten(alarm), (err) => {
        if(err) {
          log.error("Failed to set alarm: " + err);
          callback(err);
          return;
        }

        this.addToActiveQueue(alarm, (err) => {
          if(!err) {
            audit.trace("Created alarm", alarm.type, "on", alarm.device, ":", alarm.localizedMessage());
            this.publisher.publish("ALARM", "ALARM:CREATED", alarm.aid);
          }
          
          callback(err);
        });
      });
    });
  }

  checkAndSave(alarm, callback) {
    callback = callback || function() {}

    exceptionManager.match(alarm, (err, result, matches) => {
      if(err) {
        callback(err);
        return;
      }

      if(result) {
        matches.forEach((e) => {
          log.info("Matched Exception: " + e.rules);
        });
        callback(new Error("exception covered"));
        return;
      }

      this.saveAlarm(alarm, callback);

    });
  }

  // top 20 only by default
  loadActiveAlarms(number, callback) {

    if(typeof(number) == 'function') {
      callback = number;
      number = 20;
    }
    
    callback = callback || function() {}

    rclient.zrevrange(alarmActiveKey, 0, number -1 , (err, results) => {
      if(err) {
        log.error("Failed to load active alarms: " + err);
        callback(err);
        return;
      }

      let multi = rclient.multi();

      results.forEach((aid) => {
        multi.hgetall(alarmPrefix + aid);
      });

      multi.exec((err, results) => {
        if(err) {
          log.error("Failed to load active alarms (hgetall): " + err);
          callback(err);
          return;          
        }

        let processResult = function(result) {
//          let unflatten = flat.unflatten(result);
          let obj = Object.assign(Object.create(Alarm.Alarm.prototype), result);
          obj.message = obj.localizedMessage();
          return obj;
        }

        callback(null, results.map((r) => processResult(r)));
      });
    });
  }

  blockFromAlarm(alarmID, callback) {
    log.info("block alarm " + alarmID);
    callback(null);
  }

  allowFromAlarm(alarmID, callback) {
    log.info("allow alarm " + alarmID);
    callback(null);
  }

  enrichOutboundAlarm(alarm) {
    if(! alarm instanceof Alarm.OutboundAlarm) {
      return Promise.reject(new Error("invalid alarm type"));
    }

    let destIP = alarm.getDestinationIPAddress();

    return new Promise((resolve, reject) => {
      im._location(destIP, (err, loc) => {
        if(err)
          reject(err);
        let location = loc.loc;
        let ll = location.split(",");
        if(ll.length === 2) {
          alarm["p.dest.latitude"] = parseFloat(ll[0]);
          alarm["p.dest.longitude"] = parseFloat(ll[1]);        
        }
        alarm["p.dest.country"] = loc.country; // FIXME: need complete location info
        resolve(alarm);
      });
    });
  }
}

