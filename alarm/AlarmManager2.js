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

function formatBytes(bytes,decimals) {
   if(bytes == 0) return '0 Bytes';
   var k = 1000,
       dm = decimals || 2,
       sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
       i = Math.floor(Math.log(bytes) / Math.log(k));
   return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// TODO: Support suppres alarm for a while

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
        rclient.incr(alarmIDKey, (err, newID) => {
          if(err) {
            log.error("Failed to incr alarmIDKey: " + err);
          }
          callback(null, newID);
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

    console.log(alarm.timestamp / 1000);
    
    let score = alarm.timestamp / 1000;
    let id = alarm.aid;
    rclient.zadd(alarmActiveKey, score, id, (err) => {
      if(err) {
        log.error("Failed to add alarm to active queue: " + err);
      }
      callback(err);
    });
  }

  isNumber(n) {
    return Number(n) === n;
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

    if(!this.isNumber(alarm.timestamp) || alarm.timestamp === NaN) {
      log.error("Invalid timestamp, expect number");
      return false;
    }

    if(!this.isNumber(alarm.alarmTimestamp)) {
      log.error("Invalid alarm timestamp, expect number");
      return false;
    }
    return true;
  }

  createAlarmFromJson(json, callback) {
    callback = callback || function() {}

    callback(null, this.jsonToAlarm(json));
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
            audit.trace("Created alarm", alarm.aid, "-", alarm.type, "on", alarm.device, ":", alarm.localizedMessage());
            this.publisher.publish("ALARM", "ALARM:CREATED", alarm.aid);
          }
          
          callback(err, alarm.aid);
        });
      });
    });
  }

  dedup(alarm, callback) {
    //TODO enable dedup of alarms so that no dup alarms will be sent to users
  }

  checkAndSave(alarm, callback) {
    callback = callback || function() {}

    let verifyResult = this.validateAlarm(alarm);
    if(!verifyResult) {
      callback(new Error("invalid alarm, failed to pass verification"));
      return;
    }

    exceptionManager.match(alarm, (err, result, matches) => {
      if(err) {
        callback(err);
        return;
      }

      if(result) {
        matches.forEach((e) => {
          log.info("Matched Exception: " + e.rules);
        });
        callback(new Error("alarm is covered by exceptions"));
        return;
      }

      this.saveAlarm(alarm, callback);

    });
  }

  jsonToAlarm(json) {
    let proto = Alarm.mapping[json.type];
    if(proto) {
      let obj = Object.assign(Object.create(proto), json);
      obj.message = obj.localizedMessage(); // append locaized message info
      return obj;
    } else {
      log.error("Unsupported alarm type: " + json.type);
      return null;
    }
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

        callback(null, results.map((r) => this.jsonToAlarm(r)).filter((r) => r != null));
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

    alarm["p.transfer.outbound.humansize"] = formatBytes(alarm["p.transfer.outbound.size"]);
    alarm["p.transfer.inbound.humansize"] = formatBytes(alarm["p.transfer.inbound.size"]);
    
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

