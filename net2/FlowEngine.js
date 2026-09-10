/*    Copyright 2026 Firewalla Inc.
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

// Which program handles each pcap role, decided by two features:
//   pcap_zeek_fleet      fleet runs as brofish.service instead of zeek
//   pcap_zeek_suricata   fleet evaluates the suricata rule set instead of suricata
// Defaults come from the platform's files/config.json (userFeatures), the
// runtime state from sys:features like every other feature. The shell side
// (platform.sh get_flow_engine_zeek / get_flow_engine_suricata) reads the same
// two sources; scripts/fleet-engine.sh turns the answers into systemd drop-ins.

const fc = require('./config.js');
const f = require('./Firewalla.js');
const Constants = require('./Constants.js');
const fs = require('fs');

const FLEET_BIN = `${f.getRuntimeInfoFolder()}/assets/fleet`;
// main-start leaves this behind when its fleet-engine.sh apply failed: the
// drop-ins do not match the features, so brofish / suricata must not be
// started until an apply succeeds (FleetEnginePlugin clears it)
const APPLY_FAILED_MARKER = '/dev/shm/fleet-engine.failed';

// the binary arrives as an asset; until it is there (or if it goes missing)
// both roles resolve to the stock engines, the same rule platform.sh applies
function fleetAvailable() {
  try {
    fs.accessSync(FLEET_BIN, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function zeekEngine() {
  return fc.isFeatureOn(Constants.FEATURE_PCAP_ZEEK_FLEET) && fleetAvailable() ? 'fleet' : 'zeek';
}

function suricataEngine() {
  return fc.isFeatureOn(Constants.FEATURE_PCAP_SURICATA_FLEET) && fleetAvailable() ? 'fleet' : 'suricata';
}

// true while the systemd drop-ins are known not to match the features
function applyHeld() {
  try {
    fs.accessSync(APPLY_FAILED_MARKER);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { zeekEngine, suricataEngine, fleetAvailable, applyHeld, FLEET_BIN, APPLY_FAILED_MARKER };
