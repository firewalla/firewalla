'use strict'

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');
let Alarm = require('./Alarm.js')

var extend = require('util')._extend

const minimatch = require('minimatch')

module.exports = class {
  constructor(rules) {
    // FIXME: ignore any rules not begin with prefix "p"
    extend(this, rules);
    this.timestamp = new Date() / 1000;
  }

  match(alarm) {

    let matched = false;
    
    // FIXME: exact match only for now, and only supports String
    for (var key in this) {
      
      if(!key.startsWith("p.") && key !== "type") {
        continue;
      }

      var val = this[key];
      if(!alarm[key]) return false;
      let val2 = alarm[key];

      if(val.startsWith("*.")) {
        // use glob matching
        if(!minimatch(val2, val) &&
           val.slice(2) === val2) { // exact sub domain match
          return false
        }

      } else {
        if(val2 !== val) return false;        
      }

      matched = true;
    }
    
    return matched;
  }
}
