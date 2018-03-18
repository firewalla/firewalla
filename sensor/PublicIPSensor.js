/*    Copyright 2016 Firewalla LLC
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
let log = require('../net2/logger.js')(__filename);

let Sensor = require('./Sensor.js').Sensor;

let sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let exec = require('child-process-promise').exec;

let command = "dig +short myip.opendns.com @208.67.220.222";
let redisKey = "sys:network:info";
let redisHashKey = "publicIp";

class PublicIPSensor extends Sensor {
  constructor() {
    super();
  }

  job() {
    return async(() => {
      try {
        // dig +short myip.opendns.com
        let result = await (exec(command));
        let publicIP = result.stdout.split("\n")[0];
        let existingPublicIPJSON = await (rclient.hgetAsync(redisKey, redisHashKey));
        let existingPublicIP = JSON.parse(existingPublicIPJSON);
        if(publicIP !== existingPublicIP) {
          await (rclient.hsetAsync(redisKey, redisHashKey, JSON.stringify(publicIP)));
          sem.emitEvent({
            type: "PublicIP:Updated",
            ip: publicIP
          });
          sem.emitEvent({
            type: "PublicIP:Updated",
            ip: publicIP,
            toProcess: 'FireApi'
          });
        }
      } catch(err) {
        log.error("Failed to query public ip:", err, {});
      }
    })();
  }

  run() {
    this.job();
    setInterval(() => {
      this.job();
    }, 1000 * 60 * 60 * 24); // check in every day
  }
}

module.exports = PublicIPSensor;
