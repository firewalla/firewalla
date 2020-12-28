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

const Policy = require('../alarm/Policy.js');
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();

// const alreadyAppliedFlag = "default_c_hash_init_done";
// const policyTarget = "default_c_hash";

const policyTargetObj = {
  "default_c_init_done" : "default_c",
  "default_c_hash_init_done" : "default_c_hash"
}
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
    
    for(const alreadyAppliedFlag of Object.keys(policyTargetObj)) {
      const flag = await rclient.hgetAsync("sys:config", alreadyAppliedFlag);
      const policyTarget = policyTargetObj[alreadyAppliedFlag];
      if(flag === "1") {
        // already init, quit now
        log.info("Already Inited, skip");
        continue;
      }
      
      const policies = await pm2.loadActivePoliciesAsync();
  
      let alreadySet = false;
  
      for (let index = 0; index < policies.length; index++) {
        const policy = policies[index];
        
        if(policy.type === policyType  && policy.target === policyTarget) {
          alreadySet = true;
          break;
        }
  
      }
  
      if(!alreadySet) {
        const policyPayload = {
          target: policyTarget,
          type: policyType,
          dnsmasq_only: true
        }
  
        try {
          const { policy } = await pm2.checkAndSaveAsync(new Policy(policyPayload))  
          
          log.info(`${policyTarget} policy is created successfully, pid:`, policy.pid);
  
        } catch(err) {
          log.error(`Failed to create ${policyTarget} policy:`, err)
        }
        
      }
  
      await rclient.hsetAsync("sys:config", alreadyAppliedFlag, "1");
    }

  }
  
}

module.exports = ActiveProtectSensor;
