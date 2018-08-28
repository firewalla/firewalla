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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor

const sem = require('../sensor/SensorEventManager.js').getInstance()

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird')
const extensionManager = require('./ExtensionManager.js')

const fc = require('../net2/config.js')

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();

const alreadyAppliedFlag = "default_c_init_done";

const policyTarget = "default_c";
const policyType = "category";

// enable default_c policy by default

class ActiveProtectSensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    this.job().catch((err) => {
      log.error("Failed to run active protect sensor:", err);
    })
  }

  async job() {
    const flag = await rclient.hgetAsync("sys:config", alreadyAppliedFlag);
    
    if(flag === "1") {
      // already init, quit now
      log.info("Already Inited, skip");
      return;
    }
    
    const policies = await pm2.loadActivePolicysAsync(1000);

    let alreadySet = false;

    for (let index = 0; index < policies.length; index++) {
      const policy = policies[index];
      
      if(policy.type === policyType && policy.target === policyTarget) {
        alreadySet = true;
        break;
      }

    }

    if(!alreadySet) {
      const policyPayload = {
        target: policyTarget,
        type: policyType
      }

      const policy = pm2.createPolicy(policyPayload);

      try {
        const policyResult = await pm2.checkAndSaveAsync(policy)  
        
        log.info("default_c policy is created successfully, pid:", policyResult.pid);

      } catch(err) {
        log.error("Failed to create default_c policy:", err)
      }
      
    }

    await rclient.hsetAsync("sys:config", alreadyAppliedFlag, "1");

  }
  
}

module.exports = ActiveProtectSensor;
