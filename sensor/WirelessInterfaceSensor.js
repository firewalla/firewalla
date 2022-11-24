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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const cp = require('child_process');
const util = require('util');
const execAsync = util.promisify(cp.exec);
const sem = require('../sensor/SensorEventManager.js').getInstance();

class WirelessInterfaceSensor extends Sensor {
  run() {
    setInterval(() => {
      this.detect();
    }, 60000);
  }

  async detect() {
    let cmd = "iw dev | awk '$1==\"Interface\"{print $2}'"
    let output = await execAsync(cmd).then((result) => {
      return result.stdout;
    }).catch((err) => {
      log.error("Failed to find wireless interfaces", err);
      return "";
    });
    const intfs = output.split("\n").filter((line) => line.length > 0);
    if (intfs.length == 0)
      return;
    log.info("Detected wireless interfaces: ", intfs);
    sem.emitEvent({
      type: "WirelessInterfaceDetected",
      message: "Wireless interfaces detected",
      intfs: intfs
    })
  }
}

 module.exports = WirelessInterfaceSensor;