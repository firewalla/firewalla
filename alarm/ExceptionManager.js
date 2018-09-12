'use strict';

let log = require('../net2/logger.js')(__filename, 'info');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const Promise = require('bluebird');

const minimatch = require('minimatch')

let Exception = require('./Exception.js');
let Bone = require('../lib/Bone.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

let instance = null;

const exceptionQueue = "exception_queue";

const exceptionIDKey = "exception:id";
let initID = 1;
const exceptionPrefix = "exception:";

const flat = require('flat');
let audit = require('../util/audit.js');

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

        let rr = results.map((r) => Object.assign(Object.create(Exception.prototype), r))

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
    return async(() => {
      return new Promise(function (resolve, reject) {
        em.loadExceptions((err, exceptions) =>{
          if (err) {
            log.error("failed to load exceptions:", err, {})
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
    })();
  }

  checkAndSave(exception, callback) {
    return async(() => {
      let exceptions = await(this.getSameExceptions(exception))
      if (exceptions && exceptions.length > 0) {
        log.info(`exception ${exception} already exists in system: ${exceptions}`)
        callback(null, exceptions[0], true)
      } else {
        let ee = await (this.saveExceptionAsync(exception))
        callback(null, ee)
      }
    })().catch((err) => {
      callback(err)
    })
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

    rclient.hmset(exceptionKey, flat.flatten(exception), (err) => {
      if(err) {
        log.error("Failed to set exception: " + err);
        callback(err);
        return;
      }

      this.enqueue(exception, (err) => {
        if(!err) {
          audit.trace("Created exception", exception.eid);
//            this.publisher.publish("EXCEPTION", "EXCEPTION:CREATED", exception.eid);
        }

        callback(err, exception);
      });
    });

    // ignore is set for backward compatibility, it's actually should be called "allow"
    Bone.submitIntelFeedback('ignore', exception, 'exception');
  }

  exceptionExists(exceptionID) {
    return new Promise((resolve, reject) => {
      rclient.keys(exceptionPrefix + exceptionID, (err, result) => {
        if(err) {
          reject(err);
          return;
        }

        resolve(result !== null);
      });
    });
  }

  deleteException(exceptionID) {
    log.info("Trying to delete exception " + exceptionID);
    return this.exceptionExists(exceptionID)
      .then((exists) => {
        if(!exists) {
          log.error("exception " + exceptionID + " doesn't exists");
          return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
          let multi = rclient.multi();

          rclient.hgetall(exceptionPrefix + exceptionID, (err, obj) => {
            if(err) {
              log.error(`exception ${exceptionID} doesn't exist`)
              reject(err)
              return
            }
            
            log.info("Exception in CB: ", obj, {});
            let exception = obj;

            multi.srem(exceptionQueue, exceptionID);
            multi.del(exceptionPrefix + exceptionID);
            multi.exec((err) => {
              if (err) {
                log.error("Fail to delete exception: " + err);
                reject(err);
              }

            });

            // unignore is set for backward compatibility, it's actually should be called "unallow"
            Bone.submitIntelFeedback('unignore', exception, "exception");

            resolve();
          });

        });

      });
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

  match(alarm, callback) {

    if(this.isFirewallaCloud(alarm)) {
      callback(null, true, [])
      return
    }

    this.loadExceptions((err, results) => {
      if(err) {
        callback(err);
        return;
      }

      let matches = results.filter((e) => e.match(alarm));
      if(matches.length > 0) {
        log.info("Alarm " + alarm.aid + " is covered by exception " + matches.map((e) => e.eid).join(","));
        callback(null, true, matches);
      } else {
        callback(null, false);
      }
    });
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

};
