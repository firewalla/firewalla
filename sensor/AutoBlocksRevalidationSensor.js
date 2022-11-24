/*    Copyright 2019-2021 Firewalla Inc.
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

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const PolicyManager2 = require('../alarm/PolicyManager2');
const pm2 = new PolicyManager2();

const fc = require('../net2/config.js');
const featureName = "cyber_security.autoUnblock";

const f = require('../net2/Firewalla.js');

class AutoBlocksRevalidationSensor extends Sensor {

  constructor(config) {
    super(config);

    this.config.intelExpireTime = 2 * 24 * 3600; // two days
    this.unblockExpireTime = this.config.unblockExpireTime || 6 * 3600;
  }

  async run() {

    setTimeout(() => {
      if(fc.isFeatureOn(featureName)) {
        this.enable();
      } else {
        this.disable();
      }

      fc.onFeature("featureName", (feature, status) => {
        if(feature !== featureName) {
          return;
        }

        if(status) {
          this.enable();
        } else {
          this.disable();
        }
      })
    }, 5 * 60 * 1000); // start first run in 5 minutes

  }

  async enable() {
    this.timer = setInterval(() => {
      this.iterateAllAutoBlocks();
    }, this.config.jobInterval || 15 * 60 * 1000);

    this.iterateAllAutoBlocks()
  }

  async disable() {
    if(this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  shouldAutoBlock(policyRule, intel) {
    if(!policyRule || !intel) {
      return false;
    }

    if(intel.category === 'intel' && intel.action === 'block') {
      return true;
    }

    if(intel.category === 'intel' && Number(intel.t) >= 10) {
      if(policyRule.fd && policyRule.fd === 'in') {
        return false;
      } else {
        return true;
      }
    }

    return false;
  }

  async iterateAllAutoBlocks() {
    log.info("Iterating auto blocks...");
    const rules = await pm2.loadActivePoliciesAsync();

    const autoBlockRules = rules.filter((rule) => rule && rule.method === 'auto' && !rule.shouldDelete);

    if (autoBlockRules.length === 0) {
      log.info("No active auto blocks");
      return;
    }

    let revertCount = 0;

    for (const autoBlockRule of autoBlockRules) {

      let ip = null;
      let domain = null;

      if (["dns", "domain"].includes(autoBlockRule.type)) {
        ip = autoBlockRule.target_ip;
        domain = autoBlockRule.target;
      } else if ("ip" === autoBlockRule.type) {
        ip = autoBlockRule.target;
        domain = ip;
      }

      if (!ip) {
        continue;
      }

      log.debug(`Revalidating ip ${ip}...`);

      const intel = await intelTool.getIntel(ip);
      if (!intel) { // missing intel

        log.info(`Missing intel for ip ${ip}, creating...`); // next round it will be picked by this sensor again
        sem.emitEvent({
          type: 'DestIP',
          ip: ip
        });

      } else {

        if (!this.shouldAutoBlock(autoBlockRule, intel)) { // not auto block any more

          log.info(`Revert auto block on ip ${ip} (domain ${domain}) since it's not dangerous any more`);

          await intelTool.setUnblockExpire(ip, this.unblockExpireTime);

          // TODO
          // if severity is reduced to from auto block to alarm, then does user need to manually take action on this ip address when auto block is reverted.
          // It may still be dangerous, just not risky enough to be auto block
          //
          // should user be aware of this change??

          revertCount++;

          if (this.config.dryrun) {
            await pm2.markAsShouldDelete(autoBlockRule.pid);
          } else {
            await pm2.disableAndDeletePolicy(autoBlockRule.pid);
          }

        } else {
          // need to keep all relevant keys for this ip
          log.debug(`Extending ttl for intel on ip ${ip}...`);

          // intel
          await intelTool.updateExpire(ip, this.config.intelExpireTime);

          // dns
          const dnsEntry = await intelTool.getDNS(ip);
          if (dnsEntry) {
            await intelTool.updateDNSExpire(ip, this.config.intelExpireTime);
          }

          // ssl
          const sslEntry = await intelTool.getSSLCertificate(ip);
          if (sslEntry) {
            await intelTool.updateSSLExpire(ip, this.config.intelExpireTime);
          }
        }

      }
    }

    if(f.isDevelopmentVersion() && revertCount > 0) {
      sem.sendEventToFireApi({
        type: 'FW_NOTIFICATION',
        titleKey: 'NOTIF_REVERT_AUTOBLOCK_TITLE',
        bodyKey: 'NOTIF_REVERT_AUTOBLOCK_BODY',
        titleLocalKey: 'REVERT_AUTOBLOCK',
        bodyLocalKey: 'REVERT_AUTOBLOCK',
        bodyLocalArgs: [revertCount],
        payload: {
          count: revertCount
        }
      });
    }
  }
}

module.exports = AutoBlocksRevalidationSensor;
