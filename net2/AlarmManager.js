/*    Copyright 2016 Rottiesoft LLC 
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

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

var uuid = require('uuid');

var bone = require("../lib/Bone.js");



/* alarms:
    alarmtype:  intel/newhost/scan/log
    severityscore: out of 100  
    alarmseverity: major minor
*/



module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("./logger.js")("AlarmManager", loglevel);
            instance = this;
        }
        return instance;
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
        obj['id'] = uuid.v4();
        obj['alarmtype'] = alarmtype;
        obj['alarmseverity'] = alarmseverity;
        obj['severityscore'] = severityscore;
        if (actionobj != null) {
            obj['actionobj'] = actionobj;
        }
        if (obj['ts'] == null) {
            obj['ts'] = Date.now() / 1000;
        }

        let redisObj = [key, obj.ts, JSON.stringify(obj)];
        log.info("alarm:ip4:", key, actionobj);

        if (alarmtype == 'intel') {
            bone.intel(hip, "check", {});
        }
        rclient.zadd(redisObj, (err, response) => {
            if (err) {
                log.error("alarm:save:error", err);
                if (callback)
                    callback(err, null)
            } else {
                if (hip != "0.0.0.0") {
                    this.alarm("0.0.0.0", alarmtype, alarmseverity, severityscore, obj, actionobj, callback);
                } else {
                    if (callback) {
                        callback(err, null)
                    }
                }
                rclient.expireat(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 7);
            }
        });
    }

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
                log.info("Error on alarms", err, results);
                callback(err, null);
            }

        });
    }
};
