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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;
const pairedAppEventTool = require('../net2/PairedAppEventTool.js');

const DEFAULT_PENDING_TIMEOUT = 120; // seconds an app has to send its first init before the event is fired without device name
const DEFAULT_CHECK_INTERVAL = 60; // seconds
const DEFAULT_STALE_THRESHOLD = 3600; // seconds, a pending record older than this is not a real pairing

/*
 * Backstop of the phone_paired event, see net2/PairedAppEventTool.js. netbot fires the event as soon
 * as the paired app sends its first init request, this sensor covers the app that never does.
 */
class PairedAppSensor extends Sensor {

  async apiRun() {
    // FireApi is started by FireKick right after the very first pairing, so pending records may
    // already be there before the first interval kicks in
    await this.checkPendingPairedApps();

    const interval = (this.config.checkInterval || DEFAULT_CHECK_INTERVAL) * 1000;
    setInterval(() => {
      this.checkPendingPairedApps();
    }, interval);
  }

  async checkPendingPairedApps() {
    const timeout = (this.config.pendingTimeout || DEFAULT_PENDING_TIMEOUT) * 1000;
    const stale = (this.config.staleThreshold || DEFAULT_STALE_THRESHOLD) * 1000;
    await pairedAppEventTool.flushPending(timeout, stale).catch((err) => {
      log.error("Failed to check pending paired apps", err.message);
    });
  }
}

module.exports = PairedAppSensor;
