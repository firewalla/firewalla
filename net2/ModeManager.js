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
let log = require("./logger.js")(__filename);
let fConfig = require('./config.js').getConfig();

function _enforceSpoofMode() {
  if(fConfig.newSpoof) {
    let sm = require('./SpooferManager.js')
    sm.startSpoofing()
      .then(() => {
        log.info("New Spoof is started");
      }).catch((err) => {
        log.error("Failed to start new spoof");
      });
  } else {
    // old style, might not work
    var Spoofer = require('./Spoofer.js');
    let spoofer = new Spoofer(config.monitoringInterface,{},true,true);
  }
}

function _enforceDHCPMode() {
}

function start() {
  _enforceSpoofMode();
}

module.exports = {
  startService:start
}
