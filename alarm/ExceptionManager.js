'use strict';

let log = require('../net2/logger.js')(__filename, 'info');

let async = require('async');

let Exception = require('./Exception.js');

let redis = require('redis');
let rclient = redis.createClient();

let instance = null;

let exception_key = "exception";

module.exports = class {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  loadExceptions(callback) {
    callback = callback || function() {}

    rclient.smembers(exception_key, (err, results) => {
      if(err) {
        log.error("Fail to load exceptions: " + err);
        callback(err);
      }
      callback(null, results.map((jsonString) => JSON.parse(jsonString)).map((json) => new Exception(json)));
    });
  }

  saveException(e, callback) {
    callback = callback || function() {}

    rclient.sadd(exception_key, JSON.stringify(e.rules), (err) => {
      if(err) {
        log.error("Failed to add exception: " + err);
      }
      callback(err);
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
        callback(null, true);
      } else {
        callback(null, false);
      }
    });
  }
}


