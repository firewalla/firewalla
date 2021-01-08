#!/usr/bin/env node
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

'use strict';

const log = require("../../net2/logger.js")(__filename);

const cp = require('child_process');

const util = require('util');

const execAsync = util.promisify(cp.exec);

async function _getWifiDeviceName() {
  // assume there is at most one wifi device
  let cmd = "sudo nmcli d | grep wifi | awk '{print $1}' | tr -d '\n'";
  try {
    let {stdout, stderr} = await execAsync(cmd);
    if (stderr !== "") {
      log.error("Got error output while getting wifi device name: ", cmd, stderr);
      return null;
    }
    if (stdout === "") {
      return null;
    }
    return stdout;
  } catch (err) {
    log.error("Failed to get wifi device name.", err);
    return null;
  }
}

async function _getWifiConnectionName() {
  // get existing wifi connection name, assume there is at most one wifi connection
  let cmd = "sudo nmcli c | grep wifi | awk '{print $1}' | tr -d '\n'";
  try {
    let {stdout, stderr} = await execAsync(cmd);
    if (stderr !== "") {
      log.error("Got error output while getting wifi connection name: ", cmd, stderr);
      return null;
    }
    if (stdout === "") {
      return null;
    }
    return stdout;
  } catch (err) {
    log.error("Failed to get wifi connection name.", err);
    return null;
  }
}

async function _isWifiConnectionActive(conn) {
  let cmd = util.format("sudo nmcli c show --active | awk '{print $1}' | grep %s | tr -d '\n'", conn);
  try {
    let {stdout, stderr} = await execAsync(cmd);
    if (stderr !== "") {
      log.error("Got error output while getting wifi connection status: ", cmd, stderr);
      return false;
    }
    return stdout === conn;
  } catch (err) {
    log.error("Failed to get wifi connection status for " + conn, err);
    return false;
  }
}

async function enableWifiHotspot(ssid, password) {
  const dev = await _getWifiDeviceName();
  if (dev === null) {
    throw "No wifi device is found.";
  }
  let conn = await _getWifiConnectionName();
  if (conn === null) {
    // create a new wifi hotspot connection
    conn = "fire-wifi";
    let cmd = util.format("sudo nmcli c add type wifi ifname %s con-name %s autoconnect no ssid %s", dev, conn, ssid);
    let result = await execAsync(cmd);
    if (result.stderr !== "") {
      log.error("Got error while enabling wifi hotspot: ", cmd, result.stderr);
      throw result.stderr;
    }
  }
  if (await _isWifiConnectionActive(conn)) {
    log.error("Wifi is already active: " + conn);
    throw "Wifi is already active";
  }
  // connection is already created and not activated, set it to ap mode
  let cmd = util.format("sudo nmcli c modify %s 802-11-wireless.mode ap 802-11-wireless.band bg ipv4.method shared", conn);
  let result = await execAsync(cmd);
  if (result.stderr !== "") {
    log.error("Got error while enabling wifi hotspot: ", cmd, result.stderr);
    throw stderr;
  }
  // set password
  cmd = util.format("sudo nmcli c modify %s 802-11-wireless-security.key-mgmt wpa-psk 802-11-wireless-security.psk %s", conn, password);
  result = await execAsync(cmd);
  if (result.stderr !== "") {
    log.error("Got error while enabling wifi hotspot: ", result.stderr);
    throw result.stderr;
  }
  // activate wifi connection
  cmd = util.format("sudo nmcli c up %s", conn);
  result = await execAsync(cmd);
  if (result.stderr !== "") {
    log.error("Got error while enabling wifi hotspot: ", cmd, result.stderr);
    throw result.stderr;
  }
}

async function disableWifiHotspot() {
  const dev = await _getWifiDeviceName();
  if (dev == null) {
    throw "No wifi device is found.";
  }
  let conn = await _getWifiConnectionName();
  if (conn === null) {
    throw "No wifi connection is found.";
  }
  // silently return if connection is already down
  if (_isWifiConnectionActive(conn)) {
    let cmd = util.format("sudo nmcli c down %s", conn);
    let {stdout, stderr} = await execAsync(cmd);
    if (stderr !== "") {
      log.error("Got error while disabling wifi hotspot: ", cmd, stderr);
      throw stderr;
    }
  }
}

module.exports = {
  enableWifiHotspot: enableWifiHotspot,
  disableWifiHotspot: disableWifiHotspot
}