/*    Copyright 2016 Firewalla LLC / Firewalla LLC 
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

'use strict'

const log = require('../net2/logger.js')(__filename, 'info');

const extend = require('util')._extend

const minimatch = require("minimatch")


module.exports = class {
  constructor(info) {
    this.timestamp = new Date() / 1000;
    if(info)
      extend(this, info);
  }

  match(alarm) {

    // for each policy type
    switch(this.type) {
    case "ip":
      if(alarm['p.dest.ip']) {
        return this.target === alarm['p.dest.ip']        
      } else {
        return false
      }
      break
    case "dns":
    case "domain":
      if(alarm['p.dest.name']) {
        return minimatch(alarm['p.dest.name'], `*.${this.target}`) ||
          alarm['p.dest.name'] === this.target
      } else {
        return false
      }
      break
    case "mac":
      if(alarm['p.device.mac']) {
        return alarm['p.device.mac'] === this.target
      } else {
        return false
      }
      break
    case "devicePort":
      return false // no alarm supports on devicePort yet
      break
    default:
      return false
      break
    }
  }
}

