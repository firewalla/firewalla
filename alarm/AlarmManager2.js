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

const rclient = require('../util/redis_manager.js').getRedisClient()

var bone = require("../lib/Bone.js");

let flat = require('flat');

let audit = require('../util/audit.js');
let util = require('util');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const fc = require('../net2/config.js')

const f = require('../net2/Firewalla.js');

const Promise = require('bluebird');

const IntelManager = require('../net2/IntelManager.js')
const intelManager = new IntelManager('info');

const DNSManager = require('../net2/DNSManager.js');
const dnsManager = new DNSManager('info');

const getPreferredBName = require('../util/util.js').getPreferredBName

let Policy = require('./Policy.js');

let PolicyManager2 = require('./PolicyManager2.js');
let pm2 = new PolicyManager2();

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

let instance = null;

const alarmActiveKey = "alarm_active";
const alarmArchiveKey = "alarm_archive";
let ExceptionManager = require('./ExceptionManager.js');
let exceptionManager = new ExceptionManager();

let Exception = require('./Exception.js');

const FWError = require('../util/FWError.js')

let alarmIDKey = "alarm:id";
let alarmPrefix = "_alarm:";
let initID = 1;

let c = require('../net2/MessageBus.js');

let extend = require('util')._extend;

let fConfig = require('../net2/config.js').getConfig();

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const Queue = require('bee-queue')

const alarmDetailPrefix = "_alarmDetail";

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

      this.setupAlarmQueue();
    }
    return instance;
  }

  setupAlarmQueue() {

    this.queue = new Queue(`alarm-${f.getProcessName()}`, {
      removeOnFailure: true,
      removeOnSuccess: true
    })

    this.queue.on('error', (err) => {
      log.error("Queue got err:", err)
    })

    this.queue.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${job.name} failed with error ${err.message}`);
    });

    this.queue.destroy(() => {
      log.info("alarm queue is cleaned up")
    })

    this.queue.process((job, done) => {
      const event = job.data;
      const alarm = this.jsonToAlarm(event.alarm);
      const action = event.action;
      
      switch(action) {
      case "create": {
        (async () => {
          try {
            log.info("Try to create alarm:", event.alarm);
            await this.checkAndSaveAsync(alarm);
            log.info(`Alarm ${alarm.aid} is created successfully`);
          } catch(err) {
            log.error("failed to create alarm:" + err);
          }

          log.info("complete alarm creation process", alarm.aid, {});
          done();          
        })();

        break
      }

      default:
        log.error("unrecoganized policy enforcement action:" + action)
        done()
        break
      }
    })
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

  removeFromActiveQueueAsync(alarmID) {
    return rclient.zremAsync(alarmActiveKey, alarmID)
  }

  isAlarmTypeEnabled(alarm) {
    const alarmType = alarm.type
    const featureKey = `alarm:${alarmType}`
    return fc.isFeatureOn(featureKey)
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

  ignoreAlarm(alarmID) {
    log.info("Going to ignore alarm " + alarmID);

    return async(() => {
      let alarm = await (this.getAlarm(alarmID))
      if(!alarm) {
        throw new Error(`Invalid alarm id: ${alarmID}`)
        return
      }

      // alarm.result = "ignore"
      // await (this.updateAlarm(alarm))
      await (this.archiveAlarm(alarm.aid))
    })()
  }

  reportBug(alarmID, feedback) {
    log.info("Going to report feedback on alarm", alarmID, feedback, {})

    return async(() => {
      //      await (this.ignoreAlarm(alarmID)) // TODO: report issue to cloud
    })()
  }

  notifAlarm(alarmID) {
    return this.getAlarm(alarmID)
      .then((alarm) => {
        if(!alarm) {
          log.error(`Invalid Alarm (id: ${alarmID})`)
          return
        }
        
        let data = {
          notif: alarm.localizedNotification(),
          alarmID: alarm.aid,
          aid: alarm.aid,
          alarmNotifType:alarm.notifType,
          alarmType: alarm.type,
          testing: alarm["p.monkey"]
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
  
  // exclude extended info from basic info, these two info will be stored separately 
  
  parseRawAlarm(alarm) {
    const alarmCopy = JSON.parse(JSON.stringify(alarm));
    const keys = Object.keys(alarmCopy);
    const extendedInfo = {};    

    keys.forEach((key) => {
      if(key.startsWith("e.") || key.startsWith("r.")) {
        extendedInfo[key] = alarmCopy[key];
        delete alarmCopy[key];
      }
    });
    
    return {basic: alarmCopy, extended: extendedInfo};
  }
  
  saveAlarm(alarm, callback) {
    callback = callback || function() {}

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      alarm.aid = id + ""; // covnert to string to make it consistent

      let alarmKey = alarmPrefix + id;
      
      const flatted = flat.flatten(alarm);
      
      const {basic, extended} = this.parseRawAlarm(flatted);

      rclient.hmset(alarmKey, basic, (err) => {
        if(err) {
          log.error("Failed to set alarm: " + err);
          callback(err);
          return;
        }

        let expiring = fConfig.sensors.OldDataCleanSensor.alarm.expires || 24*60*60*30;  // a month
        rclient.expireat(alarmKey, parseInt((+new Date) / 1000) + expiring);

        this.addToActiveQueue(alarm, (err) => {
          if(!err) {
            audit.trace("Created alarm", alarm.aid, "-", alarm.type, "on", alarm.device, ":", alarm.localizedMessage());

            // add extended info, extended info are optional
            (async () => {
              const extendedAlarmKey = `${alarmDetailPrefix}:${alarm.aid}`;
              
              // if there is any extended info
              if(Object.keys(extended).length !== 0 && extended.constructor === Object) {
                await rclient.hmsetAsync(extendedAlarmKey, extended);
                await rclient.expireatAsync(extendedAlarmKey, parseInt((+new Date) / 1000) + expiring);
              }
              
            })().catch((err) => {
              log.error(`Failed to store extended data for alarm ${alarm.aid}, err: ${err}`);
            })
            
            setTimeout(() => {
              this.notifAlarm(alarm.aid);
            }, 1000);
          }

          callback(err, alarm.aid);
        });
      });
    });
  }  

  removeAlarmAsync(alarmID, callback) {
    callback = callback || function() {}

    return async(() => {
      await (this.removeFromActiveQueueAsync(alarmID))

      let alarmKey = alarmPrefix + alarmID
      await (rclient.delAsync(alarmKey))
    })()
  }

  dedup(alarm) {
    return new Promise((resolve, reject) => {
      let duration = fc.getTimingConfig("alarm.cooldown") || 15 * 60 // 15 minutes
      if(alarm.type === 'ALARM_LARGE_UPLOAD') {
        duration = fc.getTimingConfig("alarm.large_upload.cooldown") || 60 * 60 * 4 // for upload activity, only generate one alarm per 4 hours.
      }
      if (alarm.type === 'ALARM_VPN_CLIENT_CONNECTION') {
        duration = fc.getTimingConfig("alarm.vpn_client_connection.cooldown") || 60 * 60 * 4; // for vpn client connection activities, only generate one alarm per 4 hours.
      }
      
      this.loadRecentAlarms(duration, (err, existingAlarms) => {
        if(err) {
          reject(err);
          return;
        }

        let dups = existingAlarms
                            .filter((a) => a != null)
                            .filter((a) => alarm.isDup(a));

        if(dups.length > 0) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  enqueueAlarm(alarm) {
    if(this.queue) {
      const job = this.queue.createJob({
        alarm: alarm,
        action: "create"
      })
      job.timeout(60000).save(function() {})
    }
  }

  checkAndSaveAsync(alarm) {
    return new Promise((resolve, reject) => {
      this.checkAndSave(alarm, (err, alarmID) => {
        if(err) {
          reject(err);
        } else {
          resolve(alarmID);
        }
      })
    })
  }

  checkAndSave(alarm, callback) {
    callback = callback || function() {};

    (async () => {

      const il = require('../intel/IntelLoader.js');

      alarm = await il.enrichAlarm(alarm);

      let verifyResult = this.validateAlarm(alarm);
      if(!verifyResult) {
        callback(new Error("invalid alarm, failed to pass verification"));
        return;
      }

      const result = await bone.arbitration(alarm);

      if(!result) {
        callback(new Error("invalid alarm, failed to pass cloud verification"));
        return;
      }

      alarm = this.jsonToAlarm(result);

      if(!alarm) {
        callback(new Error("invalid alarm json from cloud"));
        return;
      }

      if(alarm["p.cloud.decision"] && alarm["p.cloud.decision"] === 'ignore') {
        log.info(`Alarm is ignored by cloud: ${alarm}`);
        callback(null, 0);
      } else {
        if(alarm["p.cloud.decision"] && alarm["p.cloud.decision"] === 'block') {
          log.info(`Decison from cloud is auto-block`, alarm.type, alarm["p.device.ip"], alarm["p.dest.ip"]);
        }
        this._checkAndSave(alarm, callback);
      }
    })();
  }

  _checkAndSave(alarm, callback) {
    callback = callback || function() {}
    
    // disable this check for now, since we use new way to check feature enable/disable
    // let enabled = this.isAlarmTypeEnabled(alarm)
    // if(!enabled) {
    //   callback(new Error(`alarm type ${alarm.type} is disabled`))
    //   return
    // }

    // HACK, update rdns if missing, sometimes intel contains ip => domain, but rdns entry is missing
    const destName = alarm["p.dest.name"]
    const destIP = alarm["p.dest.ip"]
    if(destName && destIP && destName !== destIP) {
      dnsTool.addReverseDns(destName, [destIP])
    }
    
    log.info("Checking if similar alarms are generated recently");

    let dedupResult = this.dedup(alarm).then((dup) => {

      if(dup) {
        log.warn("Same alarm is already generated, skipped this time");
        log.warn("destination: " + alarm["p.dest.name"] + ":" + alarm["p.dest.ip"]);
        log.warn("source: " + alarm["p.device.name"] + ":" + alarm["p.device.ip"]);
        let err = new Error("duplicated with existing alarms");
        err.code = 'ERR_DUP_ALARM';
        callback(err);
        return;
      }

      exceptionManager.match(alarm, (err, result, matches) => {
        if(err) {
          callback(err);
          return;
        }

        if(result) {
          matches.forEach((e) => {
            log.info("Matched Exception: " + e.eid);
            exceptionManager.updateMatchCount(e.eid); // async incr the match count for each matched exception
          });
          callback(new FWError("alarm is covered by exceptions", 1));
          return;
        }

        pm2.match(alarm, (err, result) => {
          
          if(err) {
            callback(err)
            return
          }

          if(result) {
            // already matched some policy

            const err2 = new Error("alarm is covered by policies");
            err2.code = 'ERR_BLOCKED_BY_POLICY_ALREADY';
            callback(new FWError(err2))
            return
          }

          this.saveAlarm(alarm, (err, alarmID) => {
            if(err) {
              callback(err);
              return;
            }

            log.info("AlarmManager:Check:AutoBlock",alarm.aid);
            if(fConfig && fConfig.policy &&
                fConfig.policy.autoBlock &&
                fc.isFeatureOn("cyber_security.autoBlock") &&
                this.shouldAutoBlock(alarm)) {

              // auto block if num is greater than the threshold
              this.blockFromAlarm(alarm.aid, {
                method: "auto", 
                info: {
                  category: alarm["p.dest.category"] || ""
                }
              }, callback)

              if (alarm['p.dest.ip']) {
                alarm["if.target"] = alarm['p.dest.ip'];
                alarm["if.type"] = "ip";
                bone.submitIntelFeedback("autoblock", alarm, "alarm");
              }
              return;
            }

            callback(null, alarmID);
          });
          
        })


      });
    });
  }

  shouldAutoBlock(alarm) {
    if(alarm["p.cloud.decision"] === "block") {
      return true;
    } else if((alarm["p.action.block"] === "true") ||
      (alarm["p.action.block"] === true)) {
      return true
    }

    return false;
  }

  jsonToAlarm(json) {
    if(!json)
      return null;

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
        callback(null, results.map((r) => this.jsonToAlarm(r)));
      });
    }

  
  idsToAlarmsAsync(ids) {
    return new Promise((resolve, reject) => {
      this.idsToAlarms(ids, (err, results) => {
        if(err) {
          reject(err)
          return
        }

        resolve(results)
      })                       
    })
  }

  loadRecentAlarmsAsync(duration) {
    duration = duration || 10 * 60;
    return new Promise((resolve, reject) => {
      this.loadRecentAlarms(duration, (err, results) => {
        if(err) {
          reject(err)
        } else {
          resolve(results)
        }
      })
    })
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
        this.idsToAlarms(alarmIDs, (err, results) => {
          if(err) {
            callback(err);
            return;
          }

          results = results.filter((a) => a != null);
          callback(err, results);
        });
      });
    }


  loadArchivedAlarms(options) {
    options = options || {}
    
    const offset = options.offset || 0 // default starts from 0
    const limit = options.limit || 20 // default load 20 alarms

    return async(() => {
      let alarmIDs = await (rclient.
                            zrevrangebyscoreAsync(alarmArchiveKey,
                                                  "+inf",
                                                  "-inf",
                                                  "limit",
                                                  offset,
                                                  limit))
      
      let alarms = await (this.idsToAlarmsAsync(alarmIDs))

      alarms = alarms.filter((a) => a != null)

      return alarms
      
    })()
    
  }

  archiveAlarm(alarmID) {
    return async(() => {
      await (rclient.multi()
             .zrem(alarmActiveKey, alarmID)
             .zadd(alarmArchiveKey, 'nx', new Date() / 1000, alarmID)
             .execAsync())      
    })()
  }

  async listExtendedAlarms() {
    const list = await rclient.keysAsync(`${alarmDetailPrefix}:*`);

    return list.map((l) => {
      return l.replace(`${alarmDetailPrefix}:`, "");
    })
  }

  async listBasicAlarms() {
    const list = await rclient.keysAsync(`_alarm:*`);

    return list.map((l) => {
      return l.replace("_alarm:", "");
    })
  }

  async deleteExtendedAlarm(alarmID) {
    await rclient.delAsync(`${alarmDetailPrefix}:${alarmID}`);
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

  async numberOfArchivedAlarms() {
    const count = await rclient.zcountAsync(alarmArchiveKey, "-inf", "+inf");
    return count;
  }

  // top 50 only by default
  loadActiveAlarms(number, callback) {

    if(typeof(number) == 'function') {
      callback = number;
      number = 50;
    }

    callback = callback || function() {}

    rclient.zrevrange(alarmActiveKey, 0, number -1 , (err, results) => {
      if(err) {
        log.error("Failed to load active alarms: " + err);
        callback(err);
        return;
      }

      this.idsToAlarms(results, (err, results) => {
        if (err) {
          callback(err);
          return;
        }

        results = results.filter((a) => a != null);
        callback(err, results);
      });
    });
  }

  loadActiveAlarmsAsync(number) {
    number = number || 50
    return new Promise((resolve, reject) => {
      this.loadActiveAlarms(number, (err, results) => {
        if(err) {
          reject(err)
          return
        }

        resolve(results)
      })
    })
  }
  
  async getAlarmDetail(aid) {
    const key = `${alarmDetailPrefix}:${aid}`
    const detail = await rclient.hgetallAsync(key);
    if(detail) {
      for(let key in detail) {
        if(key.startsWith("r.")) {
          delete detail[key];
        }
      }
    }

    return detail;    
  }
  
  // parseDomain(alarm) {
  //   if(!alarm["p.dest.name"] ||
  //      alarm["p.dest.name"] === alarm["p.dest.ip"]) {
  //     return null // not support ip only alarm
  //   }

  //   let fullName = alarm["p.dest.name"]

  //   let items = fullName.split(".")



  // }

  findSimilarAlarmsByPolicy(policy, curAlarmID) {
    return async(() => {
      let alarms = await (this.loadActiveAlarmsAsync(200)) // load 200 alarms for comparison
      return alarms.filter((alarm) => {
        if(alarm.aid === curAlarmID) {
          return false // ignore current alarm id, since it's already blocked
        }
        
        if(alarm.result && alarm.result !== "") {
          return false
        }
        
        if(policy.match(alarm)) {
          return true
        } else {
          return false
        }
      })                  
    })()
  }

  blockAlarmByPolicy(alarm, policy, info, needArchive) {
    return async(() => {
      if(!alarm || !policy) {
        return
      }

      log.info(`Alarm to block: ${alarm.aid}`)

      alarm.result_policy = policy.pid;
      alarm.result = "block";

      if(info.method === "auto") {
        alarm.result_method = "auto";
      }

      await (this.updateAlarm(alarm))

      if(needArchive) {
        await (this.archiveAlarm(alarm.aid))
      } else {
        await (this.removeFromActiveQueueAsync(alarm.aid))
      }

      log.info(`Alarm ${alarm.aid} is blocked successfully`)
    })()
  }

  findSimilarAlarmsByException(exception, curAlarmID) {
    return async(() => {
      let alarms = await (this.loadActiveAlarmsAsync())
      return alarms.filter((alarm) => {
        if(alarm.aid === curAlarmID) {
          return false // ignore current alarm id, since it's already blocked
        }
        
        if(alarm.result && alarm.result !== "") {
          return false
        }
        
        if(exception.match(alarm)) {
          return true
        } else {
          return false
        }
      })                  
    })()
  }

  allowAlarmByException(alarm, exception, info, needArchive) {
    return async(() => {
      if(!alarm || !exception) {
        return
      }

      log.info(`Alarm to allow: ${alarm.aid}`)

      alarm.result_exception = exception.eid;
      alarm.result = "allow";

      if(info.method === "auto") {
        alarm.result_method = "auto";
      }

      await (this.updateAlarm(alarm))

      if(needArchive) {
        await (this.archiveAlarm(alarm.aid))
      } else {
        await (this.removeFromActiveQueueAsync(alarm.aid))
      }
      
      log.info(`Alarm ${alarm.aid} is allowed successfully`)
    })()
  }
  
  blockFromAlarm(alarmID, info, callback) {
    log.info("Going to block alarm " + alarmID);
    log.info("info: ", info, {});

    let intelFeedback = info.info;

    let i_target = null;
    let i_type = null;

    this.getAlarm(alarmID)
      .then((alarm) => {

        log.info("Alarm to block:", alarm, {});

        if(!alarm) {
          log.error("Invalid alarm ID:", alarmID);
          callback(new Error("Invalid alarm ID: " + alarmID));
          return;
        }

        //BLOCK
        switch (alarm.type) {
          case "ALARM_NEW_DEVICE":
            i_type = "mac";
            i_target = alarm["p.device.mac"];
            break;
          case "ALARM_BRO_NOTICE":
            const {type, target} = require('../extension/bro/BroNotice.js').getBlockTarget(alarm);

            if(type && target) {
              i_type = type;
              i_target = target;
            } else {
              log.error("Unsupported alarm type for blocking: ", alarm, {})
              callback(new Error("Unsupported alarm type for blocking: " + alarm.type))
              return
            }

            break;
          default:

          if(alarm["p.dest.name"] ===  alarm["p.dest.ip"]) {
            i_type = "ip";
            i_target = alarm["p.dest.ip"];
          } else {
            i_type = "dns";
            i_target = alarm["p.dest.name"];
          }


            if(intelFeedback) {

              switch(intelFeedback.type) {
                case "dns":
                case "domain":
                  i_type = "dns"
                  i_target = intelFeedback.target
                  break
                case "ip":
                  i_type = "ip"
                  i_target = intelFeedback.target
                  break
                case "category":
                  i_type = "category";
                  i_target = intelFeedback.target;
                  break;
                default:
                  break
              }
            }
            break;
        }

        if(!i_type || !i_target) {
          callback(new Error("invalid block: type:" + i_type + ", target: " + i_target));
          return;
        }

        let p = new Policy({
          type: i_type, //alarm.type,
          alarm_type: alarm.type,
          target: i_target,
          aid: alarmID,
          reason: alarm.type,
          "if.type": i_type,
          "if.target": i_target,
          category: (intelFeedback && intelFeedback.category) || ""
        });

        if(intelFeedback) {
          if(intelFeedback.type === 'dns' && intelFeedback.exactMatch == true) {
            p.domainExactMatch = "1";
          }
        } else {
          if(i_type === 'dns') {
            p.domainExactMatch = "1"; // by default enable domain exact match
          }
        }
        
        // add additional info
        switch(i_type) {
        case "mac":
          p.target_name = alarm["p.device.name"] || alarm["p.device.ip"];
          p.target_ip = alarm["p.device.ip"];
          break;
        case "ip":
          p.target_name = alarm["p.dest.name"] || alarm["p.dest.ip"];
          p.target_ip = alarm["p.dest.ip"];
          break;
        case "dns":
          p.target_name = alarm["p.dest.name"] || alarm["p.dest.ip"];
          p.target_ip = alarm["p.dest.ip"];
          break;
        case "category":
          p.target_name = alarm["p.dest.category"];
          p.target_ip = alarm["p.dest.ip"];
          break;
        default:
          break;
        }

        if(info.method) {
          p.method = info.method;
        }

        if(intelFeedback && intelFeedback.device) {
          p.scope = [intelFeedback.device];
        }

        log.info("Policy object:", p, {});

        // FIXME: make it transactional
        // set alarm handle result + add policy
        pm2.checkAndSave(p, (err, policy, alreadyExists) => {
          if(err)
            callback(err);
          else {
            alarm.result_policy = policy.pid;
            alarm.result = "block";

            if(info.method === "auto") {
              alarm.result_method = "auto";
            }

            async(() => {
              await (this.updateAlarm(alarm))
              
              if(alarm.result_method != "auto") {                
                // archive alarm unless it's auto block
                await (this.archiveAlarm(alarm.aid))
              }

              // // old way
              // if(!info.matchAll) {
              //   callback(null, policy)
              //   return
              // }

              log.info("Trying to find if any other active alarms are covered by this new policy")
              let alarms = await (this.findSimilarAlarmsByPolicy(p, alarm.aid))
              if(alarms && alarms.length > 0) {
                let blockedAlarms = []
                alarms.forEach((alarm) => {
                  try {
                    await (this.blockAlarmByPolicy(alarm, policy, info))
                    blockedAlarms.push(alarm)
                  } catch(err) {
                    log.error(`Failed to block alarm ${alarm.aid} with policy ${policy.pid}: ${err}`)
                  }
                })
                callback(null, policy, blockedAlarms, alreadyExists)
              } else {
                callback(null, policy, undefined, alreadyExists)
              }

            })().catch((err) => {
              callback(err)
            })                         
          }
        });
      }).catch((err) => {
        callback(err);
      });
  }

  allowFromAlarm(alarmID, info, callback) {
    log.info("Going to allow alarm " + alarmID);
    log.info("info: ", info, {});

    let userFeedback = info.info;

    let i_target = null;
    let i_type = null;

    this.getAlarm(alarmID)
      .then((alarm) => {

        log.info("Alarm to allow: ", alarm, {});

        if(!alarm) {
          log.error("Invalid alarm ID:", alarmID);
          callback(new Error("Invalid alarm ID: " + alarmID));
          return;
        }

        //IGNORE
        switch(alarm.type) {
        case "ALARM_NEW_DEVICE":
          i_type = "mac"; // place holder, not going to be matched by any alarm/policy
          i_target = alarm["p.device.ip"];
          break;
        case "ALARM_BRO_NOTICE":
          i_type = "ip";
          i_target = alarm["p.dest.ip"];
          break;
        default:

          if(alarm["p.dest.name"] ===  alarm["p.dest.ip"]) {
            i_type = "ip";
            i_target = alarm["p.dest.ip"];
          } else {
            i_type = "dns";
            i_target = alarm["p.dest.name"];
          }        

          if(userFeedback) {
            switch(userFeedback.type) {
            case "domain":
            case "dns":
              i_type = "dns"
              i_target = userFeedback.target
              break
            case "ip":
              i_type = "ip"
              i_target = userFeedback.target
              break
            case "category":
              i_type = "category";
              i_target = userFeedback.target;
              break;
            default:
              break
            }
          }
          break;
        }

        if(!i_type || !i_target) {
          callback(new Error("invalid block"));
          return;
        }

        // TODO: may need to define exception at more fine grain level
        let e = new Exception({
          type: alarm.type,
          alarm_type: alarm.type,
          reason: alarm.type,
          aid: alarmID,
          "if.type": i_type,
          "if.target": i_target,
          category: (userFeedback && userFeedback.category) || ""
        });

        switch(i_type) {
        case "mac":
          e["p.device.mac"] = alarm["p.device.mac"];
          e["target_name"] = alarm["p.device.name"];
          e["target_ip"] = alarm["p.device.ip"];
          break;
        case "ip":
          e["p.dest.ip"] = alarm["p.dest.ip"];
          e["target_name"] = alarm["p.dest.name"] || alarm["p.dest.ip"];
          e["target_ip"] = alarm["p.dest.ip"];
          break;
        case "domain":
        case "dns":
          e["p.dest.name"] = `*.${i_target}` // add *. prefix to domain for dns matching
          e["target_name"] = `*.${i_target}`
          e["target_ip"] = alarm["p.dest.ip"];
          break;
        case "category":
          e["p.dest.category"] = i_target;
          e["target_name"] = i_target;
          e["target_ip"] = alarm["p.dest.ip"];
          break;
        default:
          // not supported
          break;
        }

        if(userFeedback && userFeedback.device) {
          e["p.device.mac"] = userFeedback.device; // limit exception to a single device
        }

        log.info("Exception object:", e, {});

        // FIXME: make it transactional
        // set alarm handle result + add policy

        exceptionManager.checkAndSave(e, (err, exception, alreadyExists) => {
          if(err) {
            log.error("Failed to save exception: " + err);
            callback(err);
            return;
          }

          if(alreadyExists) {
            log.info(`exception ${e} already exists: ${exception}`)
          }

          alarm.result_exception = exception.eid;
          alarm.result = "allow";

          this.updateAlarm(alarm)
            .then(() => {
              // archive alarm
              
              this.archiveAlarm(alarm.aid)
                .then(() => {

                  async(() => {              
                    log.info("Trying to find if any other active alarms are covered by this new exception")
                    let alarms = await (this.findSimilarAlarmsByException(exception, alarm.aid))
                    if(alarms && alarms.length > 0) {
                      let allowedAlarms = []
                      alarms.forEach((alarm) => {
                        try {
                          await (this.allowAlarmByException(alarm, exception, info))
                          allowedAlarms.push(alarm)
                        } catch(err) {
                          log.error(`Failed to allow alarm ${alarm.aid} with exception ${exception.eid}: ${err}`)
                        }
                      })
                      callback(null, exception, allowedAlarms, alreadyExists)
                    } else {
                      log.info("No similar alarms are found")
                      callback(null, exception, undefined, alreadyExists)
                    }
                  })()
                })
                .catch((err) => {
                  callback(err)
                })
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

        if(!alarm) {
          log.error("Invalid alarm ID:", alarmID);
          callback(new Error("Invalid alarm ID: " + alarmID));
          return;
        }

        let pid = alarm.result_policy;

        if(!pid || pid === "") {
          alarm.result = "";
          alarm.result_policy = "";
          alarm.result_method = "";
          this.updateAlarm(alarm)
            .then(() => {
              callback(null);
            });
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

        if(!alarm) {
          log.error("Invalid alarm ID:", alarmID);
          callback(new Error("Invalid alarm ID: " + alarmID));
          return;
        }

        let eid = alarm.result_exception;

        if(!eid || eid === "") {
          alarm.result = "";
          alarm.result_policy = "";
          this.updateAlarm(alarm)
            .then(() => {
              callback(null);
            })
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


    async enrichDeviceInfo(alarm) {
      let deviceIP = alarm["p.device.ip"];
      if(!deviceIP) {
        return Promise.reject(new Error("requiring p.device.ip"));
      }

      if(deviceIP === "0.0.0.0") {
        // do nothing for 0.0.0.0
        extend(alarm, {
          "p.device.name": "0.0.0.0",
          "p.device.id": "0.0.0.0",
          "p.device.mac": "00:00:00:00:00:00",
          "p.device.macVendor": "Unknown"
        });

        return Promise.resolve(alarm);
      }

      return new Promise((resolve, reject) => {
        dnsManager.resolveLocalHost(deviceIP, (err, result) => {

          if(err ||result == null) {
            log.error("Failed to find host " + deviceIP + " in database: " + err);
            if(err)
              reject(err);
            reject(new Error("host " + deviceIP + " not found"));
            return;
          }

          let deviceName = getPreferredBName(result);
          let deviceID = result.mac;

          extend(alarm, {
            "p.device.name": deviceName,
            "p.device.id": deviceID,
            "p.device.mac": deviceID,
            "p.device.macVendor": result.macVendor || "Unknown"
          });

          resolve(alarm);
        });
      });
    }

    async enrichDestInfo(alarm) {
      if(alarm["p.transfer.outbound.size"]) {
        alarm["p.transfer.outbound.humansize"] = formatBytes(alarm["p.transfer.outbound.size"]);
      }

      if(alarm["p.transfer.inbound.size"]) {
        alarm["p.transfer.inbound.humansize"] = formatBytes(alarm["p.transfer.inbound.size"]);
      }

      let destIP = alarm["p.dest.ip"];

      if (!destIP) {
        return alarm;
      }
        
      // location
      const loc = await intelManager.ipinfo(destIP)
      if (loc && loc.loc) {
        const location = loc.loc;
        const ll = location.split(",");
        if (ll.length === 2) {
          alarm["p.dest.latitude"] = parseFloat(ll[0]);
          alarm["p.dest.longitude"] = parseFloat(ll[1]);
        }
        alarm["p.dest.country"] = loc.country; // FIXME: need complete location info
      }

      // intel
      const intel = await intelTool.getIntel(destIP)
      if (intel && intel.app) {
        alarm["p.dest.app"] = intel.app
      }

      if (intel && intel.category) {
        alarm["p.dest.category"] = intel.category
      }

      if (intel && intel.host) {
        alarm["p.dest.name"] = intel.host
      } else {
        alarm["p.dest.name"] = alarm["p.dest.name"] || alarm["p.dest.ip"];
      }
      
      // whois - domain
      
      
      
      return alarm;
    }    
}
