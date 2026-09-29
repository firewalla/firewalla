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

// Which program handles each pcap role.
//
// Two answers, and they are not the same thing:
//   zeekEngine() / suricataEngine()  what the features ask for (intent)
//   appliedZeekEngine() / appliedSuricataEngine()  what the units will run
//
// The applied answer comes from the systemd drop-ins scripts/zssids-engine.sh
// installs, so it is right from the first line of code in a process: the
// feature table is filled in asynchronously (redis), and anything reading it
// early would answer 'zeek' while zssids is in fact running. Consumers that
// care about the running program (the watchdog cron template, whether to
// restart for a signature change, whether to fetch the suricata binary) use
// the applied answer.
//
// The features:
//   pcap_zeek_fleet      zssids runs as brofish.service instead of zeek
//   pcap_suricata_fleet   zssids evaluates the suricata rule set instead of suricata
// Defaults come from the platform's files/config.json (userFeatures), the
// runtime state from sys:features like every other feature. The shell side
// (platform.sh get_flow_engine_zeek / get_flow_engine_suricata) reads the same
// two sources; scripts/zssids-engine.sh turns the answers into systemd drop-ins.

const fc = require('./config.js');
const f = require('./Firewalla.js');
const Constants = require('./Constants.js');
const fs = require('fs');

const ZSSIDS_BIN = `${f.getRuntimeInfoFolder()}/assets/zssids`;
// main-start leaves this behind when its zssids-engine.sh apply failed: the
// drop-ins do not match the features, so brofish / suricata must not be
// started until an apply succeeds (ZssidsEnginePlugin clears it)
const APPLY_FAILED_MARKER = '/dev/shm/zssids-engine.failed';

// the binary arrives as an asset; until it is there (or if it goes missing)
// both roles resolve to the stock engines, the same rule platform.sh applies
function zssidsAvailable() {
  try {
    fs.accessSync(ZSSIDS_BIN, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function zeekEngine() {
  return fc.isFeatureOn(Constants.FEATURE_PCAP_ZEEK_FLEET) && zssidsAvailable() ? 'zssids' : 'zeek';
}

function suricataEngine() {
  return fc.isFeatureOn(Constants.FEATURE_PCAP_SURICATA_FLEET) && zssidsAvailable() ? 'zssids' : 'suricata';
}

const BROFISH_DROPIN = '/etc/systemd/system/brofish.service.d/zssids.conf';
const SURICATA_DROPIN = '/etc/systemd/system/suricata.service.d/zssids.conf';

function dropinPresent(path) {
  try {
    fs.accessSync(path);
    return true;
  } catch (err) {
    return false;
  }
}

// what brofish.service / suricata.service will actually run right now
function appliedZeekEngine() {
  return dropinPresent(BROFISH_DROPIN) ? 'zssids' : 'zeek';
}

function appliedSuricataEngine() {
  return dropinPresent(SURICATA_DROPIN) ? 'zssids' : 'suricata';
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

module.exports = {
  zeekEngine, suricataEngine,
  appliedZeekEngine, appliedSuricataEngine,
  zssidsAvailable, applyHeld, ZSSIDS_BIN, APPLY_FAILED_MARKER,
};
