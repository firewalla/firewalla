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

const log = require('../net2/logger.js')(__filename);

let util = require('util');

let Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const PolicyManager2 = require('../alarm/PolicyManager2.js')
const pm2 = new PolicyManager2()

const ExceptionManager = require('../alarm/ExceptionManager.js')
const em = new ExceptionManager()

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let fConfig = require('../net2/config.js').getConfig();

class OldDataCleanSensor extends Sensor {
  constructor() {
    super();
  }

  getExpiredDate(type) {
    let expireInterval = (this.config[type] && this.config[type].expires) || 0;
    let minInterval = 30 * 60;
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

  cleanSumFlow() {
    
  }

  cleanHourlyFlow() {
    
  }

  cleanAggrFlow() {
    
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

  cleanDuplicatedPolicy() {
    return async(() => {

      const policies = await (pm2.loadActivePolicysAsync(1000))
      
      let toBeDeleted = []

      for(let i = 0; i < policies.length; i++) {
        let p = policies[i]
        for(let j = i+1; j< policies.length; j++) {
          let p2 = policies[j]
          if(p && p2 && p.isEqualToPolicy(p2)) {
            toBeDeleted.push(p)
            break
          }
        }
      }

      for(let k in toBeDeleted) {
        let p = toBeDeleted[k]
        await (pm2.deletePolicy(p.pid))
      }
    })()
  }

  cleanDuplicatedException() {
    return async(() => {
      let exceptions = [];
      try {
        exceptions = await(em.loadExceptionsAsync());
      } catch (err) {
        log.error("Error when loadExceptions", err);
      }

      let toBeDeleted = []

      for(let i = 0; i < exceptions.length; i++) {
        let e = exceptions[i]
        for(let j = i+1; j< exceptions.length; j++) {
          let e2 = exceptions[j]
          if(e && e2 && e.isEqualToException(e2)) {
            toBeDeleted.push(e)
            break
          }
        }
      }

      for(let k in toBeDeleted) {
        let e = toBeDeleted[k]
        try {
          await(em.deleteException(e.eid))
        } catch (err) {
          log.error("Error when delete exception", err);
        }
      }
    })()
  }

  cleanInvalidMACAddress() {
    return async(() => {
      const macs = await (hostTool.getAllMACs())
      const invalidMACs = macs.filter((m) => {
        return m.match(/[a-f]+/) != null
      })
      invalidMACs.forEach((m) => {
        await (hostTool.deleteMac(m))
      })
    })()
  }

  oneTimeJob() {
    return async(() => {
      await (this.cleanDuplicatedPolicy())
      await (this.cleanDuplicatedException())
      await (this.cleanInvalidMACAddress())
    })()
  }

  scheduledJob() {
    return async(() => {
      log.info("Start cleaning old data in redis")

      await (this.regularClean("conn", "flow:conn:*"));
      await (this.regularClean("ssl", "flow:ssl:*"));
      await (this.regularClean("http", "flow:http:*"));
      await (this.regularClean("notice", "notice:*"));
      await (this.regularClean("intel", "intel:*", [/^intel:ip/]));
      await (this.regularClean("software", "software:*"));
      await (this.regularClean("monitor", "monitor:flow:*"));
      await (this.regularClean("alarm", "alarm:ip4:*"));
      await (this.cleanHourlyStats());
      await (this.cleanUserAgents());
      await (this.cleanHostData("host:ip4", "host:ip4:*", 60*60*24*30));
      await (this.cleanHostData("host:ip6", "host:ip6:*", 60*60*24*30));
      await (this.cleanHostData("host:mac", "host:mac:*", 60*60*24*365));
      log.info("scheduledJob is executed successfully");
    })();
  }

  listen() {
    sclient.on("message", (channel, message) => {
      if(channel === "OldDataCleanSensor" && message === "Start") {
        this.scheduledJob();
      }
    });
    sclient.subscribe("OldDataCleanSensor");
    log.info("Listen on channel FlowDataCleanSensor");
  }


  // could be disabled in the future when all policy blockin rule is migrated to general policy rules
  hostPolicyMigration() {
    return async(() => {
      const keys = await (rclient.keysAsync("policy:mac:*"))
      if(keys) {
        keys.forEach((key) => {
          const blockin = await (rclient.hgetAsync(key, "blockin"))
          if(blockin && blockin == "true") {
            const mac = key.replace("policy:mac:", "")
            const rule = await (pm2.findPolicy(mac, "mac"))
            if(!rule) {
              log.info(`Migrating blockin policy for host ${mac} to policyRule`)
              const hostInfo = await (hostTool.getMACEntry(mac))
              const newRule = pm2.createPolicy({
                target: mac,
                type: "mac",
                target_name: hostInfo.name || hostInfo.bname || hostInfo.ipv4Addr,
                target_ip: hostInfo.ipv4Addr // target_name and target ip are necessary for old app display
              })
              const result = await (pm2.checkAndSaveAsync(newRule))
              if(result) {
                await (rclient.hsetAsync(key, "blockin", false))
                log.info("Migrated successfully")
              } else {
                log.error("Failed to migrate")
              }
            }
          }
        })
      }
    })().catch((err) => {
      log.error("Failed to migrate host policy rules:", err, {})
    })
  }

  run() {
    super.run();

    this.listen();

    this.hostPolicyMigration()

    setTimeout(() => {
      this.scheduledJob();
      this.oneTimeJob()
      setInterval(() => {
        this.scheduledJob();
      }, 1000 * 60 * 60); // cleanup every hour
    }, 1000 * 60 * 5); // first time in 5 mins
  }
}

module.exports = OldDataCleanSensor;
