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

const Sensor = require('./Sensor.js').Sensor
const cp = require('child-process-promise');
const Constants = require('../net2/Constants');
const rclient = require('../util/redis_manager.js').getRedisClient();

class CPUSensor extends Sensor {
  async run() {
    await this.startUsageCheck();
  }

  async startUsageCheck() {
    const vmstatPromise = cp.spawn("vmstat", ["-n", "-w", `${this.config.checkInterval || 5}`]);
    const vmstat =  vmstatPromise.childProcess;
    /*
    --procs-- -----------------------memory---------------------- ---swap-- -----io---- -system-- --------cpu--------
       r    b         swpd         free         buff        cache   si   so    bi    bo   in   cs  us  sy  id  wa  st
       0    0          768      1036444       213424       925396    0    1     0     5    1    2   1   2  97   0   0
       0    0          768      1038172       213424       925396    0    0     0     0  767  887   1   2  97   0   0
       1    0          768      1046304       213424       925396    0    0     0    60  874 1678   1   6  94   0   0
    */
    vmstat.stdout.on('data', async (data) => {
      const nums = data.toString().trim().split(/\s+/g);
      const [user, sys, idle, iowait] = nums.slice(12, 16).map(Number);
      const ts = Date.now() / 1000;
      if (!isNaN(user)) {
        await rclient.zaddAsync(Constants.REDIS_KEY_CPU_USAGE, ts, JSON.stringify({user, sys, idle, iowait, ts})).catch((err) => {});
      }
    });
    vmstatPromise.catch((err) => {
      log.error(`vmstat encountered error`, err.message);
      setTimeout(() => {
        this.startUsageCheck();
      }, 10000);
    })
  }
}

module.exports = CPUSensor;
