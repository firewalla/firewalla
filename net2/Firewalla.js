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
var config;
var redis = require("redis");
var rclient = redis.createClient();
log = require("../net2/logger.js")("Firewalla", "info");

let util = require('util');

// TODO: Read this from config file
let firewallaHome = process.env.FIREWALLA_HOME || "/home/pi/firewalla"
var _isProduction = null;
let _isDocker = null;

let version = null;

function getFirewallaHome() {
  return firewallaHome;
}

function getLocalesDirectory() {
  return firewallaHome + "/locales";
}

function getUserID() {
  return process.env.USER;
}

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

function getLogFolder() {
  return getUserHome() + "/.forever";
}

function getHiddenFolder() {
  return getUserHome() + "/.firewalla";
}

function isProduction() {
  // if either of condition matches, this is production environment
  if (_isProduction==null) {
    _isProduction =  process.env.FWPRODUCTION != null || require('fs').existsSync("/tmp/FWPRODUCTION");
  }
  return _isProduction;
}

function isDocker() {
  if(_isDocker == null) {
    _isDocker = require('fs').existsSync("/.dockerenv");
  }

  return _isDocker;
}

function getRuntimeInfoFolder() {
  return getHiddenFolder() + "/run";
}

function getUserConfigFolder() {
  return getHiddenFolder() + "/config";
}

// Get config data from fishbone
var _boneInfo = null;
function getBoneInfo(callback) {
    rclient.get("sys:bone:info",(err,data)=>{
        if (data) {
            _boneInfo = JSON.parse(data);
            if (callback) {
                callback(null, JSON.parse(data));
            }
        } else {
            if (callback) {
                callback(null,null);
            }
        }
    });
}

function getBoneInfoSync() {
    return _boneInfo;
}

function getVersion() {
  if(!version) {
    let cmd = "git describe --tags";
    let versionElements = require('child_process').execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').split("-");

    if(versionElements.length === 3) {
      version = util.format("%s.%s (%s)", versionElements[0], versionElements[1], versionElements[2]);
    } else {
      version = "";
    }
  }

  return version;
}

var __constants = {
  "MAX_V6_PERHOST":6
};

function constants(name) {
    return __constants[name] 
}

function redisclean(config,count) {
        let  MAX_CONNS_PER_FLOW = 25000
        let  MAX_HTTP_PER_FLOW = 500
        if (count!=null && count >0) {
             MAX_CONNS_PER_FLOW = count;
        }
        log.info("Cleaning entries MAX_CONN", MAX_CONNS_PER_FLOW);
        this.config = config;
        rclient.keys("flow:conn:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.conn.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                //log.info("Expring for ",keys[k],expireDate);
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {

                  // drop old flows to avoid explosion due to p2p connections
                  rclient.zremrangebyrank(keys[k], 0, -1 * MAX_CONNS_PER_FLOW, (err, data) => {
                    if(data !== 0) {
                      log.warn(data + " entries of flow " + keys[k] + " are dropped for self protection")
                    }
                  })
                    //    log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });


                rclient.zcount(keys[k],'-inf','+inf',(err,data) => {
                     log.info("REDISCLEAN: flow:conn ",keys[k],data);
                });
            }
        });
        rclient.keys("flow:ssl:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.ssl.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                  rclient.zremrangebyrank(keys[k], 0, -1 * 1000, (err, data) => {
                    if(data !== 0) {
                      log.warn(data + " entries of flow " + keys[k] + " are dropped for self protection")
                    }
                  })
                });
            }
        });
        rclient.keys("flow:http:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.http.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                  //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                  if(data !== 0) {
                    log.warn(data + " entries of flow " + keys[k] + " are dropped (by ts) for self protection")
                  }
                  
                  
                  // drop old flows to avoid explosion due to p2p connections
                  rclient.zremrangebyrank(keys[k], 0, -1 * MAX_HTTP_PER_FLOW, (err, data) => {
                    if(data !== 0) {
                      log.warn(data + " entries of flow " + keys[k] + " are dropped (by count) for self protection")
                    }
                  })

                });
            }
        });
        rclient.keys("notice:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.notice.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("intel:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.intel.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
                rclient.zremrangebyrank(keys[k], 0, -20, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("software:*", (err, keys) => {
            var expireDate = Date.now() / 1000 - this.config.bro.software.expires;
            if (expireDate > Date.now() / 1000 - 8 * 60 * 60) {
                expireDate = Date.now() / 1000 - 8 * 60 * 60;
            }
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],err,data);
                });
            }
        });
        rclient.keys("monitor:flow:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 8 * 60 * 60;
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("alarm:ip4:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 60 * 60 * 24 * 7;
            for (let k in keys) {
                rclient.zremrangebyscore(keys[k], "-inf", expireDate, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
                rclient.zremrangebyrank(keys[k], 0, -20, (err, data) => {
                    //log.debug("Host:Redis:Clean",keys[k],expireDate,err,data);
                });
            }
        });
        rclient.keys("stats:hour*",(err,keys)=> {
            let expireDate = Date.now() / 1000 - 60 * 60 * 24 * 30 * 6;
            for (let j in keys) {
                rclient.zscan(keys[j],0,(err,data)=>{
                    if (data && data.length==2) {
                       let array = data[1];
                       for (let i=0;i<array.length;i++) {
                           if (array[i]<expireDate) {
                               rclient.zrem(keys[j],array[i]);
                           }
                           i += Number(1);
                       }
                    }
                });
            }
        });
        let MAX_AGENT_STORED = 150;
        rclient.keys("host:user_agent:*",(err,keys)=>{
            for (let j in keys) {
                rclient.scard(keys[j],(err,count)=>{
                    log.info(keys[j]," count ", count);
                    if (count>MAX_AGENT_STORED) {
                        log.info(keys[j]," pop count ", count-MAX_AGENT_STORED);
                        for (let i=0;i<count-MAX_AGENT_STORED;i++) {
                            rclient.spop(keys[j],(err)=>{
                                if (err) {
                                    log.info(keys[j]," count ", count-MAX_AGENT_STORED, err);
                                }
                            });
                        }
                    }
                });
            }
        });
        rclient.keys("host:ip4:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 60*60*24*30;
            for (let k in keys) {
                rclient.hgetall(keys[k],(err,data)=>{
                    if (data &&  data.lastActiveTimestamp) {
                         if (data.lastActiveTimestamp < expireDate) {
                             log.info(keys[k],"Deleting due to timeout ", expireDate, data);
                             rclient.del(keys[k]);
                         }
                    }
                });
            }
        });
        rclient.keys("host:ip6:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 60*60*24*30;
            for (let k in keys) {
                rclient.hgetall(keys[k],(err,data)=>{
                    if (data &&  data.lastActiveTimestamp) {
                         if (data.lastActiveTimestamp < expireDate) {
                             log.info(keys[k],"Deleting due to timeout ", expireDate, data);
                             rclient.del(keys[k]);
                         }
                    }
                });
            }
        });
        rclient.keys("host:mac:*", (err, keys) => {
            let expireDate = Date.now() / 1000 - 60*60*24*365;
            for (let k in keys) {
                rclient.hgetall(keys[k],(err,data)=>{
                    if (data &&  data.lastActiveTimestamp) {
                         if (data.lastActiveTimestamp < expireDate) {
                             log.info(keys[k],"Deleting due to timeout ", expireDate, data);
                             rclient.del(keys[k]);
                         }
                    }
                });
            }
        });
}

module.exports = {
  getFirewallaHome: getFirewallaHome,
  getLocalesDirectory: getLocalesDirectory,
  getUserHome: getUserHome,
  getHiddenFolder: getHiddenFolder,
  isProduction: isProduction,
  getLogFolder: getLogFolder,
  getRuntimeInfoFolder: getRuntimeInfoFolder,
  getUserConfigFolder: getUserConfigFolder,
  getUserID: getUserID,
  getBoneInfo: getBoneInfo,
  getBoneInfoSync: getBoneInfoSync,
  redisclean: redisclean,
  constants: constants,
  getVersion: getVersion,
  isDocker:isDocker
}

