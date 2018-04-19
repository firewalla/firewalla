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

const Promise = require('bluebird')

let FWEvent = class {
  constructor(eid, type) {
    this.eid = eid;
    this.type = type;
    this.timestamp = new Date()/1000;
    this.message = "";
  }
}

let Sensor = class {
  constructor() {
    this.config = {};
  }

  getName() {
    return this.constructor.name
  }
  
  setConfig(config) {
    require('util')._extend(this.config, config);
  }

  // main entry for firemain
  run() {
    // do nothing in base class
    log.info(require('util').format("%s is launched", typeof this.constructor));
  }


  // main entry for fireapi
  apiRun() {

  }

  // main entry for firemon
  monitorRun() {

  }
  
  delay(t) {
    return new Promise(function(resolve) {
      setTimeout(resolve, t)
    });
  }
}

module.exports = {
  FWEvent: FWEvent,
  Sensor: Sensor
}
