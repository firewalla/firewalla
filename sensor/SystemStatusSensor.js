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

const exec = require('child-process-promise').exec

const bone = require("../lib/Bone.js");


class SystemStatusSensor extends Sensor {
  constructor(config) {
    super(config);
    
    this.wip = false;
    log.info("heapsensor is running");
  }

  async job() {
    const result = await this.dmesg()
    if (result) {
      await bone.logAsync("error", {
        msg: result,
        type: 'dmesg'
      })
    }
  }


  // return null for succeed, other for error

  async dmesg() {
    try {
      await exec("dmesg | fgrep 'mmc0: Card stuck in programming state! mmc_do_erase'")
      return "mmc0: Card stuck in programming state! mmc_do_erase"
    } catch (err) {
      return null
    }
  }

  run() {
    this.job()

    setInterval(() => {
      this.job()
    }, 3600 * 24 * 1000) // every day
  }
}

module.exports = SystemStatusSensor;
