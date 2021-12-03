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

const PolicyManager2 = require('../alarm/PolicyManager2.js')
const pm2 = new PolicyManager2()

class PolicyGuardSensor extends Sensor {
  job() {
    log.info("reinforce policy...")
    if(pm2.queue) {
      const job = pm2.queue.createJob({
        action: "incrementalUpdate"
      })
      job.timeout(60000) // 60 seconds at most
        .save()
        .then((job) => {
          log.info("reinforce job is queue-ed")
        })

    }
  }

  run() {
    setInterval(() => {
      this.job();
    }, this.config.interval || 1000 * 60 * 60 * 2); // every two hours
  }
}

module.exports = PolicyGuardSensor
