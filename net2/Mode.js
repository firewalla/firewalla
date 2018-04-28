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

const Promise = require('bluebird');

const rclient = require('../util/redis_manager.js').getRedisClient()

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const log = require('./logger.js')(__filename)

let _setupMode = null



let REDIS_KEY_MODE = "mode"

// several supported modes
let MODE_NONE = "none"
let MODE_AUTO_SPOOF = "spoof" // use spoof for backward compatibility
let MODE_MANUAL_SPOOF = "manualSpoof"
let MODE_DHCP = "dhcp"

let DEFAULT_MODE = MODE_NONE

function getSetupModeSync() {
  return _setupMode
}

function getSetupMode() {
  if(_setupMode) {
    return Promise.resolve(_setupMode);
  }

  return reloadSetupMode();
}

function reloadSetupMode() {
  return rclient.getAsync(REDIS_KEY_MODE)
    .then((mode) => {
      if(mode) {
        _setupMode = mode;
        return mode;
      } else {
        // no mode set in redis, use default one
        _setupMode = DEFAULT_MODE;
        rclient.setAsync(REDIS_KEY_MODE, DEFAULT_MODE); // async no need to check return result, failure of this action is acceptable
        return _setupMode;
      }
    });
}

function setSetupMode(newMode) {
  log.info("Setting mode to", newMode)
  return rclient.setAsync(REDIS_KEY_MODE, newMode)
    .then(() => {
      _setupMode = newMode;
      return newMode;
    });
}

function dhcpModeOn() {
  return setSetupMode(MODE_DHCP)
}

function spoofModeOn() {
  return autoSpoofModeOn()
}

function autoSpoofModeOn() {
  return setSetupMode(MODE_AUTO_SPOOF)
}

function manualSpoofModeOn() {
  return setSetupMode(MODE_MANUAL_SPOOF)
}

function noneModeOn() {
  return setSetupMode(MODE_NONE)
}

function isDHCPModeOn() {
  return isXModeOn(MODE_DHCP)
}

function isSpoofModeOn() {
  return isAutoSpoofModeOn()
}

function isAutoSpoofModeOn() {  
  return isXModeOn(MODE_AUTO_SPOOF)
}

function isManualSpoofModeOn() {  
  return isXModeOn(MODE_MANUAL_SPOOF)
}

function isNoneModeOn() {
  return isXModeOn(MODE_NONE)
}

function isXModeOn(x) {
  if(_setupMode && _setupMode === x) {
    return Promise.resolve(true);
  }

  return getSetupMode()
    .then((mode) => {
      return mode === x;
    });
}

module.exports = {
  isSpoofModeOn:isSpoofModeOn,
  isDHCPModeOn:isDHCPModeOn,
  isManualSpoofModeOn:isManualSpoofModeOn,
  isNoneModeOn:isNoneModeOn,
  isAutoSpoofModeOn:isAutoSpoofModeOn,

  getSetupModeSync:getSetupModeSync,
  getSetupMode:getSetupMode,
  reloadSetupMode:reloadSetupMode,
  setSetupMode:setSetupMode,
  
  dhcpModeOn: dhcpModeOn,
  spoofModeOn: spoofModeOn,
  autoSpoofModeOn: autoSpoofModeOn,
  manualSpoofModeOn: manualSpoofModeOn,
  noneModeOn: noneModeOn,
  
  MODE_NONE: MODE_NONE,
  MODE_AUTO_SPOOF: MODE_AUTO_SPOOF,
  MODE_MANUAL_SPOOF: MODE_MANUAL_SPOOF,
  MODE_DHCP: MODE_DHCP
};
