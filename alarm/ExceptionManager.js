/*    Copyright 2016-2019 Firewalla INC
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

const log = require('../net2/logger.js')(__filename, 'info');

const minimatch = require('minimatch')

const Exception = require('./Exception.js');
const Bone = require('../lib/Bone.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

let instance = null;

const exceptionQueue = "exception_queue";

const exceptionIDKey = "exception:id";
const initID = 1;
const exceptionPrefix = "exception:";

const flat = require('flat');

const _ = require('lodash');
const Alarm = require('../alarm/Alarm.js');

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  getExceptionKey(exceptionID) {
    return exceptionPrefix + exceptionID
  }

  getException(exceptionID) {
    return new Promise((resolve, reject) => {
      this.idsToExceptions([exceptionID], (err, results) => {
        if(err) {
          reject(err);
          return;
        }

        if(results == null || results.length === 0) {
          reject(new Error("exception not exists"));
          return;
        }

        resolve(results[0]);
      });
    });
  }


  idsToExceptions(ids, callback) {
    let multi = rclient.multi();

    ids.forEach((eid) => {
      multi.hgetall(exceptionPrefix + eid)
    });

    multi.exec((err, results) => {
      if(err) {
        log.error("Failed to load active exceptions (hgetall): " + err);
        callback(err);
        return;
      }
      callback(null, results.map((r) => this.jsonToException(r)));
    });
  }

  loadExceptionsAsync() {
    return new Promise((resolve, reject) => {
      this.loadExceptions((err, exceptions) => {
        if(err) {
          reject(err)
        } else {
          resolve(exceptions)
        }
      })
    })
  }

  loadExceptions(callback) {
    callback = callback || function() {}

    rclient.smembers(exceptionQueue, (err, results) => {

      if(err) {
        log.error("Fail to load exceptions: " + err);
        callback(err);
        return;
      }


      let multi = rclient.multi();

      results.forEach((eid) => {
        let key = "exception:" + eid;
        multi.hgetall(key);
      });

      multi.exec((err, results) => {
        if(err) {
          log.error("Fail to load exceptions: " + err);
          callback(err);
        }

        results = results.filter((x) => x != null) // ignore any exception which doesn't exist

        let rr = results.map((r) => new Exception(r));

        // recent first
        rr.sort((a, b) => {
          return b.timestamp > a.timestamp
        })

        callback(null, rr)

      });

    });
  }

  createExceptionIDKey(callback) {
    rclient.set(exceptionIDKey, initID, callback);
  }

  getNextID(callback) {
    rclient.get(exceptionIDKey, (err, result) => {
      if(err) {
        log.error("Failed to get exceptionIDKey: " + err);
        callback(err);
        return;
      }

      if(result) {
        rclient.incr(exceptionIDKey, (err) => {
          if(err) {
            log.error("Failed to incr exceptionIDKey: " + err);
          }
          callback(null, result);
        });
      } else {
        this.createExceptionIDKey((err) => {
          if(err) {
            log.error("Failed to create exceptionIDKey: " + err);
            callback(err);
            return;
          }

          rclient.incr(exceptionIDKey, (err) => {
            if(err) {
              log.error("Failed to incr exceptionIDKey: " + err);
            }
            callback(null, initID);
          });
        });
      }
    });
  }

  enqueue(exception, callback) {
    let id = exception.eid;
    rclient.sadd(exceptionQueue, id, (err) => {
      if(err) {
        log.error("Failed to add exception to active queue: " + err);
      }
      callback(err);
    });
  }

  getSameExceptions(exception) {
    let em = this
    return new Promise(function (resolve, reject) {
      em.loadExceptions((err, exceptions) => {
        if (err) {
          log.error("failed to load exceptions:", err);
          reject(err)
        } else {
          if (exceptions) {
            resolve(exceptions.filter((e) => e.isEqualToException(exception)))
          } else {
            resolve([])
          }
        }
      })
    })
  }

  async checkAndSave(exception, callback) {
    try {
      let exceptions = await this.getSameExceptions(exception)
      if (exceptions && exceptions.length > 0) {
        log.info(`exception ${exception} already exists in system: ${exceptions}`)
        callback(null, exceptions[0], true)
      } else {
        let ee = await this.saveExceptionAsync(exception)
        callback(null, ee)
      }
    } catch(err) {
      callback(err)
    }
  }

  async checkAndSaveAsync(exception) {
    const exceptions = await this.getSameExceptions(exception);

    if (exceptions && exceptions.length > 0) {
      log.info(`exception ${exception} already exists in system: ${exceptions}`)
      return Promise.reject(new Error("exception already exists"))
    } else {
      return this.saveExceptionAsync(exception);
    }
  }

  saveExceptionAsync(exception) {
    return new Promise((resolve, reject) => {
      this.saveException(exception, (err, ee) => {
        if(err) {
          reject(err)
        } else {
          resolve(ee)
        }
      })
    })
  }

  saveException(exception, callback) {
    callback = callback || function() {}

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }
      this._saveException(id, exception, callback);
    });
  }

  _saveException(id, exception, callback) {
    exception.eid = id + ""; // convert it to string to make it consistent with redis

    let exceptionKey = exceptionPrefix + id;


    /*
    {
      "i.type": "domain",
      "reason": "ALARM_GAME",
      "type": "ALARM_GAME",
      "timestamp": "1500913117.175",
      "p.dest.id": "battle.net",
      "target_name": "battle.net",
      "target_ip": destIP,
    }*/
    if (exception['p.tag.ids'] && _.isArray(exception['p.tag.ids'])) {
      exception['p.tag.ids'] = JSON.stringify(exception['p.tag.ids'])
    }
    rclient.hmset(exceptionKey, exception, (err) => {
      if(err) {
        log.error("Failed to set exception: " + err);
        callback(err);
        return;
      }

      this.enqueue(exception, (err) => {
        if(!err) {
//            this.publisher.publish("EXCEPTION", "EXCEPTION:CREATED", exception.eid);
        }

        callback(err, exception);
      });
    });

    // ignore is set for backward compatibility, it's actually should be called "allow"
    Bone.submitIntelFeedback('ignore', exception, 'exception');
  }

  exceptionExists(exceptionID) {
    return rclient.existsAsync(exceptionPrefix + exceptionID);
  }

  async deleteException(exceptionID) {
    log.info("Trying to delete exception " + exceptionID);

    if (!exceptionID) return;

    let exists = await this.exceptionExists(exceptionID);
    if(!exists) {
      log.error("exception " + exceptionID + " doesn't exists");
      return;
    }

    let multi = rclient.multi();

    let exception = await rclient.hgetallAsync(exceptionPrefix + exceptionID);

    log.info("Deleting Exception:", exception);

    multi.srem(exceptionQueue, exceptionID);
    multi.del(exceptionPrefix + exceptionID);

    try {
      await multi.execAsync();
    }
    catch(err) {
      log.error("Fail to delete exception: " + err);
      throw err;
    }

    // unignore is set for backward compatibility, it's actually should be called "unallow"
    Bone.submitIntelFeedback('unignore', exception, "exception");
  }

  async deleteExceptions(idList) {
    if (!idList) throw new Error("deleteException: null argument");

    if (idList.length) {
      await rclient.delAsync(idList.map(id => exceptionPrefix + id));
      await rclient.sremAsync(exceptionQueue, idList);
    }
  }

  async deleteMacRelatedExceptions(mac) {
    // remove exceptions
    let exceptions = await this.loadExceptionsAsync();
    let relatedEx = exceptions
      .filter(ex => _.isString(ex['p.device.mac']) &&
                    ex['p.device.mac'].toUpperCase() === mac.toUpperCase())
      .map(ex => ex.eid);

    await this.deleteExceptions(relatedEx);
  }

  async deleteTagRelatedExceptions(tag) {
    // remove exceptions
    let exceptions = await this.loadExceptionsAsync();
    tag = Number(tag);
    for (let index = 0; index < exceptions.length; index++) {
      const exception = exceptions[index];
      if (!_.isEmpty(exception['p.tag.ids']) && exception['p.tag.ids'].includes(tag)) {
        if (exception['p.tag.ids'].length <= 1) {
          await this.deleteException(exception.eid); 
        } else {
          let reducedTag = _.without(exception['p.tag.ids'], tag);
          exception['p.tag.ids'] = reducedTag;
          await this.updateException(exception);
        }
      }
    }
  }

  async createException(json) {
    if(!json) {
      return Promise.reject(new Error("Invalid Exception"));
    }

    if(!json.timestamp) {
      json.timestamp = new Date() / 1000;
    }

    const e = this.jsonToException(json);
    if(e) {
      return this.checkAndSaveAsync(e);
    } else {
      return Promise.reject(new Error("Invalid Exception"));
    }
  }

  async updateException(json) {
    if(!json) {
      return Promise.reject(new Error("Invalid Exception"));
    }

    if (!json.eid) {
      return Promise.reject(new Error("Invalid Exception ID"));
    }

    if(!json.timestamp) {
      json.timestamp = new Date() / 1000;
    }

    const e = this.jsonToException(json);
    if(e) {
      return this.getException(e.eid).then(() => {
        return new Promise((resolve, reject) => {
        this._saveException(e.eid, e, (err, ee) => {
          if(err) {
            reject(err)
          } else {
            resolve(ee)
          }
        })
      })
    });
    } else {
      return Promise.reject(new Error("Invalid Exception"));
    }
  }

  isFirewallaCloud(alarm) {
    const name = alarm["p.dest.name"]
    if(!name) {
      return false
    }

    return name === "firewalla.encipher.io" ||
      name === "firewalla.com" ||
      minimatch(name, "*.firewalla.com")

    // TODO: might need to add static ip address here
  }

  async match(alarm) {

    const results = await this.loadExceptionsAsync()

    let matches = results.filter((e) => e.match(alarm));
    if (matches.length > 0) {
      log.info("Alarm " + alarm.aid + " is covered by exception " + matches.map((e) => e.eid).join(","));
    }

    return matches
  }

  // incr by 1 to count how many times this exception matches alarms
  updateMatchCount(exceptionID) {
    return rclient.hincrbyAsync(this.getExceptionKey(exceptionID), "matchCount", 1)
  }

  createExceptionFromJson(json, callback) {
    callback = callback || function() {}

    callback(null, this.jsonToException(json));
  }

  jsonToException(json) {
    let proto = Exception.prototype;
    if(proto) {
      let obj = Object.assign(Object.create(proto), json);
      return obj;
    } else {
      log.error("Unsupported exception type: " + json.type);
      return null;
    }
  }

  async searchException(target) {
    let matchedExceptions = [];
    const addrPort = target.split(":");
    const val2 = addrPort[0];
    const exceptions = await this.loadExceptionsAsync();
    for (const exception of exceptions) {
      let match = false;
      for (var key in exception) {
        if(!key.startsWith("p.") && key !== "type" && !key.startsWith("e.")) {
          continue;
        }

        let payload = Object.assign({}, exception);
        payload[key] = val2;
        let alarm = new Alarm.Alarm("", Date.now(), "", payload);
        if (exception.match(alarm)) {
          match = true;
          break;
        }
      }
      if (match) {
        matchedExceptions.push(exception);
      }
    }

    return _.uniqWith(matchedExceptions.map((exception) => exception.eid), _.isEqual);
  }
};
