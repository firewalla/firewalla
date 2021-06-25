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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor

const rclient = require('../util/redis_manager.js').getRedisClient()

const Policy = require('../alarm/Policy.js');
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();

const alreadyAppliedFlag = "default_c_init_done";
const alreadyAppliedFlag1 = "default_c_init_done_dns_proxy";

const policyTarget = "default_c";
const policyType = "category";

const fc = require('../net2/config.js')

// enable default_c policy by default

class ActiveProtectSensor extends Sensor {
  run() {
    this.job().catch((err) => {
      log.error("Failed to run active protect sensor:", err);
    })
  }

  async job() {
    const flag = await rclient.hgetAsync("sys:config", alreadyAppliedFlag);
    const flag1 = await rclient.hgetAsync("sys:config", alreadyAppliedFlag1);

    if(flag === "1" && flag1 === "1") {
      // already init, quit now
      log.info("Already Inited, skip");
      return;
    }

    const policies = await pm2.loadActivePoliciesAsync();

    let alreadySet = false;

    for (let index = 0; index < policies.length; index++) {
      const policy = policies[index];

      if(policy.type === policyType && policy.target === policyTarget) {
        alreadySet = true;
        break;
      }

    }

    if (alreadySet) {
      if (!fc.isFeatureOn("dns_proxy")) {
        await fc.enableDynamicFeature("dns_proxy");
      }
    } else {
      // new box
      if(flag !== "1") {
        const policyPayload = {
          target: policyTarget,
          type: policyType,
          category: 'intel',
          method: 'auto'
        }
        
        try {
          const { policy } = await pm2.checkAndSaveAsync(new Policy(policyPayload))
  
          log.info("default_c policy is created successfully, pid:", policy.pid);
          // turn on dns proxy
          if (!fc.isFeatureOn("dns_proxy")) {
            await fc.enableDynamicFeature("dns_proxy")
          }
  
        } catch(err) {
          log.error("Failed to create default_c policy:", err)
        }
      }
    }

    await rclient.hsetAsync("sys:config", alreadyAppliedFlag, "1");
    await rclient.hsetAsync("sys:config", alreadyAppliedFlag1, "1");

  }

}

module.exports = ActiveProtectSensor;
