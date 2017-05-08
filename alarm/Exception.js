'use strict'

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');
let Alarm = require('./Alarm.js')

var extend = require('util')._extend

module.exports = class {
  constructor(rules) {
    // FIXME: ignore any rules not begin with prefix "p"
    extend(this, rules);
  }

  match(alarm) {

    let matched = false;
    
    // FIXME: exact match only for now, and only supports String
    for (var key in this) {
      
      if(!key.startsWith("p.")) {
        continue;
      }
      
      var val = this[key];
//      console.log(val);
      if(!alarm[key]) return false;

      let val2 = alarm[key];
//      console.log(val2);
      if(val2 !== val) return false;

      matched = true;
    }
    
    return matched;
  }
}
