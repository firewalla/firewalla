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

let Promise = require('bluebird');

let redis = require("redis");
let rclient = redis.createClient();

// add promises to all redis functions
Promise.promisifyAll(redis.RedisClient.prototype);

let _setupMode = null;

let defaultMode = "spoof";

function getSetupMode() {
  if(_setupMode) {
    return Promise.resolve(_setupMode);
  }

  return reloadSetupMode();
}

function reloadSetupMode() {
  return rclient.getAsync("mode")
    .then((mode) => {
      if(mode) {
        _setupMode = mode;
        return mode;
      } else {
        // no mode set in redis, use default one
        _setupMode = defaultMode;
        rclient.setAsync("mode", defaultMode); // async no need to check return result, failure of this action is acceptable
        return _setupMode;
      }
    });
}

function setSetupMode(newMode) {
  return rclient.setAsync("mode", newMode)
    .then(() => {
      _setupMode = newMode;
      return newMode;
    });
}

function dhcpModeOn() {
  return setSetupMode("dhcp");
}

function spoofModeOn() {
  return setSetupMode("spoof");
}

function isDHCPModeOn() {
  if(_setupMode && _setupMode === "dhcp") {
    return Promise.resolve(true);
  }

  return getSetupMode()
    .then((mode) => {
      return mode === "dhcp";
    });
}

function isSpoofModeOn() {
  if(_setupMode && _setupMode === "spoof") {
    return Promise.resolve(true);
  }

  return getSetupMode()
    .then((mode) => {
      return mode === "spoof";
    });
}

module.exports = {
  isSpoofModeOn:isSpoofModeOn,
  isDHCPModeOn:isDHCPModeOn,
  getSetupMode:getSetupMode,
  reloadSetupMode:reloadSetupMode,
  setSetupMode:setSetupMode,
  dhcpModeOn: dhcpModeOn,
  spoofModeOn: spoofModeOn
};
