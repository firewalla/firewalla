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

let log = require('../net2/logger.js')(__filename);

let util = require('util');

let Sensor = require('./Sensor.js').Sensor;

let redis = require("redis");
let rclient = redis.createClient();
let pubClient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let fConfig = require('../net2/config.js').getConfig();

class OldDataCleanSensor extends Sensor {
  constructor() {
    super();
  }

  getExpiredDate(type) {
    let expireInterval = (this.config[type] && this.config[type].expires) || 0;
    let minInterval = 8 * 60 * 60;
    expireInterval = Math.max(expireInterval, minInterval);

    return Date.now() / 1000 - expireInterval;
  }

  getCount(type) {
    let count = (this.config[type] && this.config[type].count) || 10000;
    return count;
  }

  cleanByExpireDate(key, expireDate) {
    return rclient.zremrangebyscoreAsync(key, "-inf", expireDate)
      .then((count) => {
        if(count > 0) {
          log.info(util.format("%d entries in %s are cleaned by expired date", count, key));
        }
      });
  }

  cleanToCount(key, leftOverCount) {
    return rclient.zremrangebyrankAsync(key, 0, -1 * leftOverCount)
      .then((count) => {
        if(count > 0) {
          log.info(util.format("%d entries in %s are cleaned by count", count, key));
        }
      });
  }

  getKeys(keyPattern) {
    return rclient.keysAsync(keyPattern);
  }

  // clean by expired time and count
  regularClean(type, keyPattern, ignorePatterns) {

    return async(() => {
      let keys = await (this.getKeys(keyPattern));

      if(ignorePatterns) {
        keys = keys.filter((x) => {
          return ignorePatterns.filter((p) => x.match(p)).length === 0
        });
      }

      keys.forEach((key) => {
        await (this.cleanByExpireDate(key, this.getExpiredDate(type)));
        await (this.cleanToCount(key, this.getCount(type)));
      })

    })();

  }

  cleanAlarm() {
    // TODO
  }

  cleanPolicy() {
    // TODO
  }

  cleanException() {
    // TODO
  }

  cleanHourlyStats() {
    // FIXME: not well coded here, deprecated code
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

    return Promise.resolve();
  }

  cleanUserAgents() {
    // FIXME: not well coded here, deprecated code
      let MAX_AGENT_STORED = 150;
      rclient.keys("host:user_agent:*", (err, keys) => {
        for (let j in keys) {
          rclient.scard(keys[j], (err, count) => {
//                    log.info(keys[j]," count ", count);
            if (count > MAX_AGENT_STORED) {
              log.info(keys[j], " pop count ", count - MAX_AGENT_STORED);
              for (let i = 0; i < count - MAX_AGENT_STORED; i++) {
                rclient.spop(keys[j], (err) => {
                  if (err) {
                    log.info(keys[j], " count ", count - MAX_AGENT_STORED, err);
                  }
                });
              }
            }
          });
        }
      });

      return Promise.resolve();
  }

  cleanHostData(type, keyPattern, defaultExpireInterval) {
    let expireInterval = (this.config[type] && this.config[type].expires) ||
      defaultExpireInterval;

    let expireDate = Date.now() / 1000 - expireInterval;

    return this.getKeys(keyPattern)
      .then((keys) => {
        return Promise.all(
          keys.map((key) => {
            return rclient.hgetallAsync(key)
              .then((data) => {
                if (data &&  data.lastActiveTimestamp) {
                  if (data.lastActiveTimestamp < expireDate) {
                    log.info(key,"Deleting due to timeout ", expireDate, data);
                    return rclient.delAsync(key);
                  } else {
                    return Promise.resolve();
                  }
                } else {
                  return Promise.resolve();
                }
              })
          })
        ).then(() => {
          // log.info("CleanHostData on", keys, "is completed", {});
        })
      });
  }

  scheduledJob() {
    return async(() => {
      log.info("Start cleaning old data in redis")

      await (this.regularClean("conn", "flow:conn:*"));
      log.info("1");
      await (this.regularClean("ssl", "flow:ssl:*"));
      log.info("2");
      await (this.regularClean("http", "flow:http:*"));
      log.info("3");
      await (this.regularClean("notice", "notice:*"));
      log.info("4");
      await (this.regularClean("intel", "intel:*", [/^intel:ip/]));
      log.info("5");
      await (this.regularClean("software", "software:*"));
      log.info("6");
      await (this.regularClean("monitor", "monitor:flow:*"));
      log.info("7");
      await (this.regularClean("alarm", "alarm:ip4:*"));
      log.info("8");
      await (this.cleanHourlyStats());
      log.info("9");
      await (this.cleanUserAgents());
      log.info("10");
      await (this.cleanHostData("host:ip4", "host:ip4:*", 60*60*24*30));
      log.info("11");
      await (this.cleanHostData("host:ip6", "host:ip6:*", 60*60*24*30));
      log.info("12");
      await (this.cleanHostData("host:mac", "host:mac:*", 60*60*24*365));

      log.info("scheduledJob is executed successfully");
    })();
  }

  listen() {
    pubClient.on("message", (channel, message) => {
      if(channel === "OldDataCleanSensor" && message === "Start") {
        this.scheduledJob();
      }
    });
    pubClient.subscribe("OldDataCleanSensor");
    log.info("Listen on channel FlowDataCleanSensor");
  }

  run() {
    super.run();

    this.listen();

    setTimeout(() => {
      this.scheduledJob();
      setInterval(() => {
        this.scheduledJob();
      }, 1000 * 60 * 60); // cleanup every hour
    }, 1000 * 60 * 5); // first time in 5 mins
  }
}

module.exports = OldDataCleanSensor;
