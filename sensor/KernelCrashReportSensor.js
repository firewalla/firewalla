/*    Copyright 2016-2026 Firewalla Inc.
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
const KernelCrashMonitor = require('../net2/KernelCrashMonitor.js');

// Boxes come back together after a coordinated upgrade or a power cut, and every one that
// is sitting on an unreported crash would otherwise POST the moment its cloud token is
// ready - cloudready() says a token exists, not that the endpoint is healthy. Spread the
// reports out. Nothing waits on this: the crash is days old by the time it is reported, and
// a box that reboots before the timer fires simply reports on the next start.
const REPORT_JITTER_MS = 10 * 60 * 1000;

// Uploads the kernel crash that disabled xt_udp_tls, once per crash.
//
// This lives in a sensor rather than in KernelCrashMonitor.checkPstoreAndUpdateRedis
// because that call happens in run0() before the cloud is known to be up, and bone.log
// drops its payload silently while it is not. Sensors are only started once that check
// has passed, so by the time run() is called the upload can actually leave the box.
//
// Boxes that disabled udp_tls before this shipped are covered by the same path: the
// decision lives in Redis and the crash records are kept under /log/system/pstore, so the
// first start after the upgrade reports and marks it done.
class KernelCrashReportSensor extends Sensor {

  async run() {
    const delay = Math.round(Math.random() * REPORT_JITTER_MS);
    log.info(`Will check for an unreported kernel crash in ${Math.round(delay / 1000)}s`);
    this.reportTask = setTimeout(() => {
      KernelCrashMonitor.reportUdpTlsDisableIfNeeded().catch((err) => {
        log.error("Failed to report kernel crash to cloud", err.message);
      });
    }, delay);
  }

}

module.exports = KernelCrashReportSensor;
