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

var DNSManager = require('../net2/DNSManager.js');
var dnsManager = new DNSManager('info');

let instance = null;

let alarmActiveKey = "alarm_active";
let ExceptionManager = require('./ExceptionManager.js');
let exceptionManager = new ExceptionManager();

let alarmIDKey = "alarm:id";
let alarmPrefix = "_alarm:";
let initID = 1;

let c = require('../net2/MessageBus.js');

let extend = require('util')._extend;

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
    let score = parseFloat(alarm.timestamp);
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

  dedup(alarm) {
    return new Promise((resolve, reject) => {
      this.loadRecentAlarms((err, existingAlarms) => {
        let dups = existingAlarms.filter((a) => this.isDup(a, alarm));
        if(dups.length > 0) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }
  
  isDup(alarm, alarm2) {
    let keysToCompare = ["p.dest.id", "p.device.mac", "type"];    

    for(var key in keysToCompare) {
      let k = keysToCompare[key];
      if(alarm[k] && alarm2[k] && alarm[k] === alarm2[k]) {
        
      } else {
        return false;
      }
    }

    return true;
  }

  checkAndSave(alarm, callback) {
    callback = callback || function() {}
    
    let verifyResult = this.validateAlarm(alarm);
    if(!verifyResult) {
      callback(new Error("invalid alarm, failed to pass verification"));
      return;
    }

    let dedupResult = this.dedup(alarm).then((dup) => {   

      if(dup) {
        callback(new Error("duplicated with existing alarms"));
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
    });
  }

  jsonToAlarm(json) {
    let proto = Alarm.mapping[json.type];
    if(proto) {
      let obj = Object.assign(Object.create(proto), json);
      obj.message = obj.localizedMessage(); // append locaized message info

      if(obj["p.flow"]) {
        delete obj["p.flow"];
      }
      
      return obj;
    } else {
      log.error("Unsupported alarm type: " + json.type);
      return null;
    }
  }
  
    idsToAlarms(ids, callback) {
      let multi = rclient.multi();
      
      ids.forEach((aid) => {
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
    }
    
    loadRecentAlarms(duration, callback) {
      if(typeof(duration) == 'function') {
        callback = duration;
        duration = 86400;
      }
      
      callback = callback || function() {}

      let scoreMax = new Date() / 1000 + 1;
      let scoreMin = scoreMax - duration;
      rclient.zrevrangebyscore(alarmActiveKey, scoreMax, scoreMin, (err, alarmIDs) => {
        if(err) {
          log.error("Failed to load active alarms: " + err);
          callback(err);
          return;
        }

        this.idsToAlarms(alarmIDs, callback);
      });
    }

  numberOfAlarms(callback) {
    callback = callback || function() {}

    rclient.zcount(alarmActiveKey, "-inf", "+inf", (err, result) => {
      if(err) {
        callback(err);
        return;
      }

      // TODO: support more than 20 in the future
      callback(null, result > 20 ? 20 : result);
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

        this.idsToAlarms(results, callback);
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

    
    enrichDeviceInfo(alarm) {
      let deviceIP = alarm["p.device.ip"];
      if(!deviceIP) {
        return Promise.reject(new Error("requiring p.device.ip"));
      }

      return new Promise((resolve, reject) => {
        dnsManager.resolveLocalHost(deviceIP, (err, result) => {
          
          if(err || result == null) {
            log.error("Failed to find host " + lh + " in database: " + err);
            if(err)
              reject(err);
            reject(new Error("host " + deviceIP + " not found"));
            return;                          
          }
          
          let deviceName = dnsManager.name(result);
          let deviceID = result.mac;

          extend(alarm, {
            "p.device.name": deviceName,
            "p.device.id": deviceID,
            "p.device.mac": deviceID,
            "p.device.macVendor": result.macVendor
          });

          resolve(alarm);
        });
      });
    }
    
    enrichDestInfo(alarm) {
      if(alarm["p.transfer.outbound.size"]) {
        alarm["p.transfer.outbound.humansize"] = formatBytes(alarm["p.transfer.outbound.size"]);
      }

      if(alarm["p.transfer.inbound.size"]) {
        alarm["p.transfer.inbound.humansize"] = formatBytes(alarm["p.transfer.inbound.size"]);
      }

      let destIP = alarm["p.dest.ip"];

      if(!destIP)
        return Promise.reject(new Error("Requiring p.dest.ip"));

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

