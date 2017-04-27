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

let flat = require('flat');
let audit = require('../util/audit.js');

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
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

      results.forEach((aid) => {
        let key = "exception:" + aid;
        multi.hgetall(key);
      });

      multi.exec((err, results) => {
        if(err) {
          log.error("Fail to load exceptions: " + err);
          callback(err);
        }
        
        callback(null, results.map((r) => flat.unflatten(r)).map((r) => Object.assign(Object.create(Exception.prototype), r)));
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
    let id = exception.aid;
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

      exception.aid = id;

      let exceptionKey = "exception:" + id;

      rclient.hmset(exceptionKey, flat.flatten(exception), (err) => {
        if(err) {
          log.error("Failed to set exception: " + err);
          callback(err);
          return;
        }

        this.enqueue(exception, (err) => {
          if(!err) {
            audit.trace("Created exception", exception.aid);
//            this.publisher.publish("EXCEPTION", "EXCEPTION:CREATED", exception.aid);
          }
          
          callback(err);
        });
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
        log.info("Alarm " + alarm.aid + " is covered by exception " + matches.map((e) => e.aid).join(","));
        callback(null, true);
      } else {
        callback(null, false);
      }
    });
  }
}


