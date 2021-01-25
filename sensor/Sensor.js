/*    Copyright 2016-2020 Firewalla Inc.
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


let FWEvent = class {
  constructor(eid, type) {
    this.eid = eid;
    this.type = type;
    this.timestamp = new Date()/1000;
    this.message = "";
  }
}

let Sensor = class {
  // this.config is set in SensorLoader.js AFTER specific sensor is initialized
  // so this.config won't be available in the constructor
  constructor() {
    this.config = {};
    this.delay = require('../util/util.js').delay;
  }

  getName() {
    return this.constructor.name
  }
  setConfig(config) {
    require('util')._extend(this.config, config);
  }

  // main entry for firemain
  run() {
    // do nothing in base class
    log.info(require('util').format("%s is launched", this.constructor.name));
  }


  // main entry for fireapi
  apiRun() {

  }

  // main entry for firemon
  monitorRun() {

  }

  async globalOn() {

  }

  async globalOff() {

  }

  hookFeature(featureName) {

    sem.once('IPTABLES_READY', async () => {
      log.info("iptables is ready, start enabling feature", featureName);
      if (fc.isFeatureOn(featureName)) {
        try {
          await this.globalOn({booting: true});
        } catch(err) {
          log.error(`Failed to enable ${featureName}, reverting...`, err)
          try {
            await this.globalOff();
            this.setFeatureStats(featureName);
          } catch(err) {
            log.error(`Failed to revert ${featureName}`, err)
          }
        }
      } else {
        try {
          await this.globalOff();
        } catch(err) {
          log.error(`Failed to disable ${featureName}`, err)
        }
      }
      fc.onFeature(featureName, async (feature, status) => {
        if (feature !== featureName) {
          return;
        }
        if (status) {
          try {
            await this.globalOn();
          } catch(err) {
            log.error(`Failed to enable ${featureName}, reverting...`, err)
            try {
              await this.globalOff();
            } catch(err) {
              log.error(`Failed to revert ${featureName}`, err)
            }
          }
        } else {
          try {
            await this.globalOff();
          } catch(err) {
            log.error(`Failed to disable ${featureName}`, err)
          }
        }
      })

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
    this.featureName = featureName;
  }

  async setFeatureStats(stats) {
    return rclient.hsetAsync("sys:features:stats", this.featureName, JSON.stringify(stats));
  }
  async getFeatureStats() {
    const stats = await rclient.hgetAsync("sys:features:stats", this.featureName);
    try {
      if(stats) {
        return JSON.parse(stats);
      }
      return {};
    } catch(err) {
      log.error(`Failed to parse stats of feature ${this.featureName}, err:`, err);
      return {};
    }
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

  }

};

module.exports = {
  FWEvent: FWEvent,
  Sensor: Sensor
}
