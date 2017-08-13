'use strict';

let log = require('../net2/logger.js')(__filename, 'info');

let async = require('async');

let Exception = require('./Exception.js');

let redis = require('redis');
let rclient = redis.createClient();

let instance = null;

let exceptionQueue = "exception_queue";

let exceptionIDKey = "exception:id";
let initID = 1;
let exceptionPrefix = "exception:";

let flat = require('flat');
let audit = require('../util/audit.js');

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
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
        
        callback(null, results.map((r) => Object.assign(Object.create(Exception.prototype), r)));
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
  
  saveException(exception, callback) {
    callback = callback || function() {}

    this.getNextID((err, id) => {
      if(err) {
        log.error("Failed to get next ID: " + err);
        callback(err);
        return;
      }

      exception.eid = id;

      let exceptionKey = exceptionPrefix + id;

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
          
          callback(err);
        });
      });
    });
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
          return Promise.reject("exception " + exceptionID + " doesn't exists");
        }

        return new Promise((resolve, reject) => {
          let multi = rclient.multi();

          multi.zrem(exceptionQueue, exceptionID);
          multi.del(exceptionPrefix + exceptionID);
          multi.exec((err) => {
            if(err) {
              log.error("Fail to delete exception: " + err);
              reject(err);
              return;
            }

            resolve();
          })
        });
      });        
  }
  
  match(alarm, callback) {
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

}


