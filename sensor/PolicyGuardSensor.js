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
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const Promise = require('bluebird');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const domainBlock = require('../control/DomainBlock.js')()

class PolicyGuardSensor extends Sensor {
  constructor() {
    super();    
  }

  job() {
    log.info("reinforce policy...")
    return async(() => {
      const list = await (domainBlock.getAllIPMappings())
      list.forEach((l) => {
        const matchDomain = l.match(/ipmapping:domain:(.*)/)
        if(matchDomain) {
          const domain = matchDomain[1]
          await (domainBlock.incrementalUpdateIPMapping(domain, {}))
          return
        } 
        
        const matchExactDomain = l.match(/ipmapping:exactdomain:(.*)/)
        if(matchExactDomain) {
          const domain = matchExactDomain[1]
          await (domainBlock.incrementalUpdateIPMapping(domain, {exactMatch: 1}))
          return
        }
      })
    })()
  }

  run() {
    setInterval(() => {
      this.job();
    }, this.config.interval || 1000 * 60 * 60 * 2); // every two hours
  }
}

module.exports = PolicyGuardSensor
