'use strict'

let log = require('../net2/logger.js')(__filename, 'info');
let jsonfile = require('jsonfile');
let util = require('util');
let Alarm = require('./Alarm.js')

module.exports = class {
  constructor(rules) {
    this.rules = rules;
  }

  match(alarm) {
    let payloads = alarm.payloads;
    
    // FIXME: exact match only for now, and only supports String
    for(var key in this.rules) {
      var val = this.rules[key];
      if(!payloads[key]) return false;

      let val2 = payloads[key];
      if(val2 !== val) return false;
    }

    return true;
  }
}
