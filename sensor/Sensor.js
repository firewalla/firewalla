/*    Copyright 2016-2023 Firewalla Inc.
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

const sem = require('../sensor/SensorEventManager.js').getInstance();
const fc = require('../net2/config.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const _ = require('lodash');


let FWEvent = class {
  constructor(eid, type) {
    this.eid = eid;
    this.type = type;
    this.timestamp = new Date()/1000;
    this.message = "";
  }
}

let Sensor = class {
  constructor(config) {
    this.config = config ? JSON.parse(JSON.stringify(config)) : {};
  }

  getName() {
    return this.constructor.name
  }

  // main entry for firemain
  run() {
    // do nothing in base class
    log.info(require('util').format("%s is launched", this.constructor.name));
  }

  setConfig(config) {
    const oldConfig = this.config;
    this.config = config ? JSON.parse(JSON.stringify(config)) : {};
    if (oldConfig && !_.isEqual(oldConfig, config)) {
      log.info(`Sensor config is changed on ${this.getName()}`, oldConfig, config);
      this.onConfigChange(oldConfig).catch((err) => {});
    }
  }

  async onConfigChange(oldConfig) {

  }


  // main entry for fireapi
  apiRun() {

  }

  // main entry for firemon
  monitorRun() {

  }

  async globalOn() { }

  async globalOff() { }

  hookFeature(featureName) {
    featureName = featureName || this.featureName
    this.featureName = featureName;

    sem.once('IPTABLES_READY', async () => {
      await lock.acquire(`${this.featureName}`, async () => {
        if (fc.isFeatureOn(featureName)) try {
          log.info("Enabling feature", featureName);
          await this.globalOn({booting: true});
        } catch(err) {
          log.error(`Failed to enable ${featureName}, reverting...`, err)
          try {
            await this.globalOff();
          } catch(err) {
            log.error(`Failed to revert ${featureName}`, err)
          }
        }
        else try {
          await this.globalOff();
        } catch(err) {
          log.error(`Failed to disable ${featureName}`, err)
        }
      })
      fc.onFeature(featureName, async (feature, status) => {
        if (feature !== featureName) {
          return;
        }
        await lock.acquire(`${this.featureName}`, async () => {
          log.info(`${status ? 'Enabling' : 'Disabling'} feature ${featureName}`);
          if (status) try {
            await this.globalOn();
          } catch(err) {
            log.error(`Failed to enable ${featureName}, reverting...`, err)
            try {
              await this.globalOff();
            } catch(err) {
              log.error(`Failed to revert ${featureName}`, err)
            }
          }
          else try {
            await this.globalOff();
          } catch(err) {
            log.error(`Failed to disable ${featureName}`, err)
          }
        })
      })

      log.debug('Global hooks registered for', this.featureName)

      try {
        await this.job();
      } catch(err) {
        log.error(`Failed to run job of ${featureName}`, err)
      }
      if (this.refreshInterval) {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(async () => {
          try {
            await this.job();
          } catch(err) {
            log.error(`Failed to run job of ${featureName}`, err)
          }
        }, this.refreshInterval);
      }

    });
  }

  async setFeatureConfig(config) {
    return rclient.hsetAsync("sys:features:config", this.featureName, JSON.stringify(config));
  }

  async getFeatureConfig() {
    const config = await rclient.hgetAsync("sys:features:config", this.featureName);
      try {
        if(config) {
          return JSON.parse(config);
        }
        return {};
      } catch(err) {
        log.error(`Failed to parse config of feature ${this.featureName}, err:`, err);
        return {};
      }
  }

  async job() {
    log.debug('running job for', this.featureName)
  }

};

module.exports = {
  FWEvent: FWEvent,
  Sensor: Sensor
}
