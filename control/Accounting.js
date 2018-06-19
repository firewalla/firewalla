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

const log = require('../net2/logger.js')(__filename);

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
    this.blockedDevices[mac] = true;
  }

  removeBlockedDevice(mac) {
    log.info("Removed block device", mac);
    delete this.blockedDevices[mac];
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