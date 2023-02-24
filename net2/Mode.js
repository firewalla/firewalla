/*    Copyright 2016-2021 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient()

const log = require('./logger.js')(__filename)

let _setupMode = null

let REDIS_KEY_MODE = "mode"

// several supported modes
let MODE_NONE = "none"
let MODE_AUTO_SPOOF = "spoof" // use spoof for backward compatibility
let MODE_MANUAL_SPOOF = "manualSpoof"
let MODE_DHCP = "dhcp"
let MODE_DHCP_SPOOF = "dhcpSpoof"
let MODE_ROUTER = "router"
const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()

let DEFAULT_MODE = MODE_NONE

function getSetupModeSync() {
  return _setupMode
}

async function getSetupMode() {
  if (_setupMode) {
    return _setupMode;
  }

  return reloadSetupMode();
}

async function reloadSetupMode() {
  const mode = await rclient.getAsync(REDIS_KEY_MODE)
  if (mode) {
    _setupMode = mode;
    return mode;
  } else {
    // no mode set in redis, use default one
    let defaultMode = MODE_NONE;
    if (platform.isFireRouterManaged()) {
      defaultMode = MODE_ROUTER;
    }
    await rclient.setAsync(REDIS_KEY_MODE, defaultMode);
    return _setupMode;
  }
}

async function setSetupMode(newMode) {
  log.info("Setting mode to", newMode)
  await rclient.setAsync(REDIS_KEY_MODE, newMode)
  _setupMode = newMode;
  return newMode;
}

function dhcpModeOn() {
  return setSetupMode(MODE_DHCP)
}

function routerModeOn() {
  return setSetupMode(MODE_ROUTER)
}

function spoofModeOn() {
  return autoSpoofModeOn()
}

function autoSpoofModeOn() {
  return setSetupMode(MODE_AUTO_SPOOF)
}

function dhcpSpoofModeOn() {
  return setSetupMode(MODE_DHCP_SPOOF)
}

function manualSpoofModeOn() {
  return setSetupMode(MODE_MANUAL_SPOOF)
}

function noneModeOn() {
  return setSetupMode(MODE_NONE)
}

function isRouterModeOn() {
  return isXModeOn(MODE_ROUTER)
}

function isDHCPModeOn() {
  return isXModeOn(MODE_DHCP)
}

async function isSpoofModeOn() {
  return (await isAutoSpoofModeOn()) || (await isDHCPSpoofModeOn())
}

function isAutoSpoofModeOn() {
  return isXModeOn(MODE_AUTO_SPOOF)
}

function isDHCPSpoofModeOn() {
  return isXModeOn(MODE_DHCP_SPOOF)
}

function isManualSpoofModeOn() {
  return isXModeOn(MODE_MANUAL_SPOOF)
}

function isNoneModeOn() {
  return isXModeOn(MODE_NONE)
}

async function isXModeOn(x) {
  if (_setupMode && _setupMode === x) {
    return true
  }

  const mode = await getSetupMode()
  return mode === x;
}

async function isModeConfigured() {
  const type = await rclient.typeAsync("mode");
  return type != "none"; // if the mode key doesn't exist, the type should be none
}

module.exports = {
  isSpoofModeOn,
  isDHCPModeOn,
  isDHCPSpoofModeOn,
  isManualSpoofModeOn,
  isNoneModeOn,
  isAutoSpoofModeOn,
  isRouterModeOn,

  getSetupModeSync,
  getSetupMode,
  reloadSetupMode,
  setSetupMode,

  dhcpModeOn,
  routerModeOn,
  spoofModeOn,
  autoSpoofModeOn,
  dhcpSpoofModeOn,
  manualSpoofModeOn,
  noneModeOn,

  MODE_NONE,
  MODE_AUTO_SPOOF,
  MODE_MANUAL_SPOOF,
  MODE_DHCP,
  MODE_DHCP_SPOOF,
  MODE_ROUTER,

  isModeConfigured,
};
