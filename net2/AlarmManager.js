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
var log;
var iptool = require('ip');
var os = require('os');
var network = require('network');
var instance = null;

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

var uuid = require('uuid');

var bone = require("../lib/Bone.js");

var hostManager = null;


/* alarms:
    alarmtype:  intel/newhost/scan/log
    severityscore: out of 100  
    alarmseverity: major minor
*/


function getDomain(ip) {
    if (ip.endsWith(".com") || ip.endsWith(".edu") || ip.endsWith(".us") || ip.endsWith(".org")) {
        let splited = ip.split(".");
        if (splited.length>=3) {
            return (splited[splited.length-2]+"."+splited[splited.length-1]);
        }
    }
    return ip;
}


module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("./logger.js")("AlarmManager", loglevel);
            instance = this;
        }
        return instance;
    }

    // duplication
    // ignored alarm
    // .. check
    //
    // callback(err, alarmObj, action) action: ignore, save, notify, duplicate
    alarmCheck(hip, alarmObj,callback) {
        // check if alarm is ignored
        // write bunch code here
        //
        log.info("alarm:check:", hip,alarmObj,{});
        let action = "notify";
        let timeblock = 10*60;
        if (alarmObj.alarmtype!="intel" && alarmObj.alarmtype!="porn") {
            timeblock = 30*60;
        }
     if (hostManager == null) {
            let HostManager = require("../net2/HostManager.js");
            hostManager = new HostManager("cli", 'client', 'info');
     }
     hostManager.isIgnoredIPs([alarmObj.actionobj.src, alarmObj.actionobj.dst,alarmObj.actionobj.shname,alarmObj.actionobj.dhname,alarmObj.dhname,alarmObj.shname],(err,ignore)=>{
       if (ignore == true) {
          log.info("######## AlarmManager:flowIntel:Ignored",alarmObj);
       }
              
       if (ignore == false) {
        this.read(hip, timeblock, null, null, null, (err, alarms)=> {
            if (alarms == null) {
                log.info("alarm:check:noprevious", hip,alarmObj);
                callback(err, alarmObj, action); 
            }  else {
                for (let i in alarms) {
                    let alarm = JSON.parse(alarms[i]);
//                    console.log("alarm:check:iterating",alarm.actionobj.src,alarmObj.actionobj.src, alarm.actionobj.dst,alarmObj.actionobj.dst, alarm.alarmtype,alarmObj.alarmtype); 
                    if (alarm.actionobj && alarmObj.actionobj) {
                        if (alarm.actionobj.src == alarmObj.actionobj.src &&
                            alarm.actionobj.dst == alarmObj.actionobj.dst &&
                            alarm.alarmtype == alarmObj.alarmtype) {
                            log.info("alarm:check:duplicate",alarm,{});
                            callback(null, null, "duplicate"); 
                            return;
                        }
                        if (alarm.actionobj.dhname && alarmObj.actionobj.dhname) {
                            if (getDomain(alarm.actionobj.dhname) == getDomain(alarmObj.actionobj.dhname)) {
                                log.info("alarm:check:duplicate:dhname",alarm,{});
                                callback(null, null, "duplicate"); 
                                return;
                            } 
                        }
                    }
                }
                callback(null, alarmObj, "notify");
            }
        });
       } else {
            callback(null,null,"ignore");
       }
     });
    }

    /**
     * Only call release function when the SysManager instance is no longer
     * needed
     */
    release() {
        rclient.quit();
        sclient.quit();
        log.debug("Calling release function of AlarmManager");
    }
    
    // 
    // action obj { 'cmd': {command object}, 'title':'display title','confirmation:' msg}
    //

    alarm(hip, alarmtype, alarmseverity, severityscore, obj, actionobj, callback) {
        let key = "alarm:ip4:" + hip;
        if (obj.uid!=null) {
            obj['id'] = obj.uid;
        } else {
            obj['id'] = uuid.v4();
        }
        obj['alarmtype'] = alarmtype;
        obj['alarmseverity'] = alarmseverity;
        obj['severityscore'] = severityscore;
        let now = Date.now()/1000;
        if (actionobj != null) {
            obj['actionobj'] = actionobj;
        }
        if (obj['ts'] == null) {
            obj['ts'] = Date.now() / 1000;
        }

        let redisObj = [key, now, JSON.stringify(obj)];
        log.info("alarm:ip4:", key, actionobj);

        if (alarmtype == 'intel') {
            //bone.intel(hip, "alarm", {});
        }
        this.alarmCheck(hip, obj, (err, alarmobj, action)=>{ 
            if (alarmobj == null ) {
                log.error("alarm:save:duplicated", err, alarmobj, obj,{} );
                if (callback) {
                    callback(err, null, action);  
                }
                return;
            }
            rclient.zadd(redisObj, (err, response) => {
                if (err) {
                    log.error("alarm:save:error", err);
                    if (callback)
                        callback(err, obj)
                } else {
                    if (hip != "0.0.0.0") {
                        this.alarm("0.0.0.0", alarmtype, alarmseverity, severityscore, obj, actionobj, callback);
                    } else {
                        if (callback) {
                            callback(err, obj)
                        }
                    }
                    rclient.expireat(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 7);
                }
            });
        });
    }


    // WARNING: Alarm are json strings, not parsed

    read(hip, secondsago, alarmtypes, alarmseverity, severityscore, callback) {
        let key = "alarm:ip4:" + hip;
        rclient.zrevrangebyscore([key, Date.now() / 1000, Date.now() / 1000 - secondsago], (err, results) => {
            if (err == null && results.length > 0) {
                let alarmsdb = {};
                let alarms = [];
                for (let i in results) {
                    let alarm = results[i]
                    let _alarm = JSON.parse(alarm);
                    if (_alarm.alarmtype == "intel") {
                        let k = "intel" + _alarm['id.resp_h'] + _alarm['id.orig_h'];
                        let old = alarmsdb[k];
                        if (old == null) {
                            alarms.push(alarm);
                            alarmsdb[k] = _alarm;
                        } else {
                            if (Math.abs(_alarm.ts - old.ts) > 60) {
                                alarms.push(alarm);
                            }
                            alarmsdb[k] = _alarm;
                        }
                    } else {
                        alarms.push(alarm);
                    }
                }
                log.info("Returning Alarms ", hip, results.length, "compressed to ", alarms.length);
                callback(null, alarms);
            } else {
                log.info("Error on alarms", key, err, results);
                callback(err, null);
            }

        });
    }
};
