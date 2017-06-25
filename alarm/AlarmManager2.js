/*    Copyright 2016 Firewalla LLC / Firewalla LLC 
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

let log = require('../net2/logger.js')(__filename, 'info');
let Alarm = require('./Alarm.js');

let redis = require('redis');
let rclient = redis.createClient();

let flat = require('flat');

let audit = require('../util/audit.js');
let util = require('util');

let Promise = require('bluebird');

let IM = require('../net2/IntelManager.js')
let im = new IM('info');

var DNSManager = require('../net2/DNSManager.js');
var dnsManager = new DNSManager('info');

let Policy = require('./Policy.js');

let PolicyManager2 = require('./PolicyManager2.js');
let pm2 = new PolicyManager2();

let instance = null;

let alarmActiveKey = "alarm_active";
let ExceptionManager = require('./ExceptionManager.js');
let exceptionManager = new ExceptionManager();

let Exception = require('./Exception.js');

let alarmIDKey = "alarm:id";
let alarmPrefix = "_alarm:";
let initID = 1;

let c = require('../net2/MessageBus.js');

let extend = require('util')._extend;

let AUTO_BLOCK_THRESHOLD = 10;

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
        // typically bug occurs if reaching this code block
        log.error("Invalid payload for " + this.type + ", missing " + k, new Error("").stack, {});
        log.error("Invalid alarm is: " + alarm, {});
        return false;
      }
    }

    return true;
  }

  createAlarmFromJson(json, callback) {
    callback = callback || function() {}

    callback(null, this.jsonToAlarm(json));
  }

  updateAlarm(alarm) {
    let alarmKey = alarmPrefix + alarm.aid;
    return new Promise((resolve, reject) => {
      rclient.hmset(alarmKey, flat.flatten(alarm), (err) => {
        if(err) {
          log.error("Failed to set alarm: " + err);
          reject(err);
          return;
        }

        resolve(alarm);
      });      
    });
  }

  notifAlarm(alarmID) {
    return this.getAlarm(alarmID)
      .then((alarm) => {
        let data = {
          notif: alarm.localizedNotification(),
          alarmID: alarm.aid,
          aid: alarm.aid,              
        };

        if(alarm.result_method === "auto") {
          data.autoblock = true;
        }
        
        this.publisher.publish("ALARM",
                               "ALARM:CREATED",
                               alarm.device,
                               data);
        
      }).catch((err) => Promise.reject(err));
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

            setTimeout(() => {
              this.notifAlarm(alarm.aid);
            }, 3000);
          }         
          
          callback(err, alarm.aid);
        });
      });
    });
  }

  dedup(alarm) {
    return new Promise((resolve, reject) => {
      this.loadRecentAlarms((err, existingAlarms) => {
        if(err) {
          reject(err);
          return;
        }
        
        let dups = existingAlarms.filter((a) => alarm.isDup(a));
        if(dups.length > 0) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
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
        log.warn("Same alarm is already generated, skipped this time");
        log.warn("destination: " + alarm["p.dest.name"] + ":" + alarm["p.dest.ip"]);
        log.warn("source: " + alarm["p.device.name"] + ":" + alarm["p.device.ip"]);
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

        this.saveAlarm(alarm, (err) => {
          if(err) {
            callback(err);
            return;
          }

          if(alarm.type === "ALARM_INTEL") {
            let num = parseInt(alarm["p.security.numOfReportSources"]);
            if(num > AUTO_BLOCK_THRESHOLD) {
              // auto block if num is greater than the threshold
              this.blockFromAlarm(alarm.aid, {method: "auto"}, callback);
              return;
            }
          }

          callback(null);
        });

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

  getAlarm(alarmID) {
    return new Promise((resolve, reject) => {
      this.idsToAlarms([alarmID], (err, results) => {
        if(err) {
          reject(err);
          return;
        }

        if(results == null || results.length === 0) {
          reject(new Error("alarm not exists"));
          return;
        }

        resolve(results[0]);
      });
    });
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
        duration = 10 * 60; // 10 minutes
//        duration = 86400;
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

  blockFromAlarm(alarmID, info, callback) {
    log.info("Going to block alarm " + alarmID);

    let alarmInfo = info.info; // not used by now

    let target = null;
    let type = null;

    this.getAlarm(alarmID)
      .then((alarm) => {

        switch(alarm.type) {
        case "ALARM_NEW_DEVICE":
          type = "mac";
          target = alarm["p.device.mac"];
          break;
        default:
          type = "ip";
          target = alarm["p.dest.ip"];
          break;
        }

        if(!type || !target) {
          callback(new Error("invalid block"));
          return;
        }
        
        let p = new Policy(type, target);
        p.aid = alarmID;
        p.reason = alarm.type;

        // add additional info
        switch(p.type) {
        case "mac":
          p.target_name = alarm["p.device.name"];
          p.target_ip = alarm["p.device.ip"];
          break;
        case "ip":
          p.target_name = alarm["p.dest.name"];
          p.target_ip = alarm["p.dest.ip"];
          break;
        default:
          break;
        }

        if(info.method)
          p.method = info.method;
        
        // FIXME: make it transactional
        // set alarm handle result + add policy
        pm2.checkAndSave(p, (err) => {
          if(err)
            callback(err);
          else {
            alarm.result_policy = p.pid;
            alarm.result = "block";

            if(info.method === "auto") {
              alarm.result_method = "auto";
            }

            this.updateAlarm(alarm)
              .then(() => {
                callback(null);
              }).catch((err) => {
                callback(err);
              });
          }
        });
      }).catch((err) => {
        callback(err);
      });   
  }

  allowFromAlarm(alarmID, info, callback) {
    log.info("Going to allow alarm " + alarmID);

    let alarmInfo = info.info; // not used by now

    let target = null;
    let type = null;

    this.getAlarm(alarmID)
      .then((alarm) => {

        switch(alarm.type) {
        case "ALARM_NEW_DEVICE":
          type = "mac"; // place holder, not going to be matched by any alarm/policy
          target = alarm["p.device.ip"];
          break;
        default:
          type = "ip";
          target = alarm["p.dest.ip"];
          break;
        }

        if(!type || !target) {
          callback(new Error("invalid block"));
          return;
        }

        // TODO: may need to define exception at more fine grain level
        let e = new Exception({
          "type": alarm.type,
          reason: alarm.type,
          aid: alarmID,
          "i.type": type
        });

        switch(type) {
        case "mac":
          e["p.device.mac"] = alarm["p.device.mac"];
          e["target_name"] = alarm["p.device.name"];
          e["target_ip"] = alarm["p.device.ip"];
          break;
        case "ip":
          e["p.dest.ip"] = alarm["p.dest.ip"];
          e["target_name"] = alarm["p.dest.name"];
          e["target_ip"] = alarm["p.dest.ip"];
          break;
        default:
          // not supported
          break;
        }

        // FIXME: make it transactional
        // set alarm handle result + add policy

        exceptionManager.saveException(e, (err) => {
          if(err) {
            log.error("Failed to save exception: " + err);
            callback(err);
            return;
          }

          alarm.result_exception = e.aid;
          alarm.result = "allow";

          this.updateAlarm(alarm)
            .then(() => {
              callback(null);
            }).catch((err) => {
              callback(err);
            });
        });
      }).catch((err) => {
        callback(err);
      });
  }

  unblockFromAlarm(alarmID, info, callback) {
    log.info("Going to unblock alarm " + alarmID);

    let alarmInfo = info.info; // not used by now
    
     this.getAlarm(alarmID)
      .then((alarm) => {

        let pid = alarm.result_policy;

        if(!pid || pid === "") {
          callback(new Error("can't unblock alarm without binding policy"));
          return;
        }

        // FIXME: make it transactional
        // set alarm handle result + add policy
        
        pm2.disableAndDeletePolicy(pid)
          .then(() => {
            alarm.result = "";
            alarm.result_policy = "";
            alarm.result_method = "";
            this.updateAlarm(alarm)
              .then(() => {
                callback(null);
              });
          }).catch((err) => {
            callback(err);
          });
        
      }).catch((err) => {
        callback(err);
      });   
  }
  
  unallowFromAlarm(alarmID, info, callback) {
    log.info("Going to unallow alarm " + alarmID);

     let alarmInfo = info.info; // not used by now
    
     this.getAlarm(alarmID)
      .then((alarm) => {

        let eid = alarm.result_exception;

        if(!eid || eid === "") {
          callback(new Error("can't unallow alarm without binding exception"));
          return;
        }

        // FIXME: make it transactional
        // set alarm handle result + add policy
        
        exceptionManager.deleteException(eid)
          .then(() => {
            alarm.result = "";
            alarm.result_policy = "";
            this.updateAlarm(alarm)
              .then(() => {
                callback(null);
              });
          }).catch((err) => {
            callback(err);
          });
        
      }).catch((err) => {
        callback(err);
      });
  }

    
    enrichDeviceInfo(alarm) {
      let deviceIP = alarm["p.device.ip"];
      if(!deviceIP) {
        return Promise.reject(new Error("requiring p.device.ip"));
      }

      return new Promise((resolve, reject) => {
        dnsManager.resolveLocalHost(deviceIP, (err, result) => {
          
          if(err ||result == null) {
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

