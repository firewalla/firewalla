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

let instance = null;

const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);

//Need to change
class Accounting {
  constructor() {
    if(!instance) {
      instance = this;
      this.blockedDevices = {};
    }

    return instance;
  }

  addBlockedDevice(mac) {
    log.info("Added block device", mac);
    if (_.has(this.blockedDevices, mac)) {
      this.blockedDevices[mac] += 1;
    } else {
      this.blockedDevices[mac] = 1;
    }
  }

  removeBlockedDevice(mac) {
    log.info("Removed block device", mac);
    if (_.has(this.blockedDevices, mac)) {
      this.blockedDevices[mac] -= 1;
      if (this.blockedDevices[mac] == 0) {
        delete this.blockedDevices[mac];
      }
    }
  }

  isBlockedDevice(mac) {
    if(mac) {
      return this.blockedDevices[mac] !== undefined;
    } else {
      return false;
    }    
  }

}

module.exports = Accounting;