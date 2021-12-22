/*    Copyright 2020-2021 Firewalla Inc.
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
const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const Sensor = require('./Sensor.js').Sensor;

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const tracking = require('../extension/accounting/tracking.js');
const accounting = require('../extension/accounting/accounting.js');
const fc = require('../net2/config.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const { generateStrictDateTs } = require('../util/util.js');
const f = require('../net2/Firewalla.js');
class AccountingPlugin extends Sensor {
  constructor(config) {
    super(config);
    this.interval = 5 * 60 * 1000; // every 5 minutes;
    this.cleanupInterval = 3600 * 1000; // every hour;
  }

  async scheduledJob() {
    if(!platform.isAccountingSupported() || !fc.isFeatureOn("accounting") || !f.isDevelopmentVersion()) {
      log.info("Accounting feature is not supported or disabled.");
      return;
    }
    
    log.info("Updating data usage for all devices...");
    const activeCategories = await accounting.getAccountList('category');
    const activeApps = await accounting.getAccountList('app');
    const macs = hostManager.getActiveMACs();
    for(const mac of macs) {
      await tracking.aggr(mac);
      const host = hostManager.getHostFastByMAC(mac);
      if(host) {
        const screenTime = {
          total:0,
          categories:{},
          apps:{}
        };
        screenTime.total = await tracking.getUsedTime(mac);
        const { beginTs, endTs } = generateStrictDateTs();
        for (const category of activeCategories) {
          screenTime.categories[category] = await accounting.count(mac, category, beginTs, endTs)
        }
        for (const app of activeApps) {
          screenTime.apps[app] = await accounting.count(mac, app, beginTs, endTs)
        }
        host.setScreenTime(screenTime);
      }
    }

    log.info("Updating data usage for all devices is complete");
  }

  async cleanupJob() {
    if (!f.isDevelopmentVersion()) return;
    log.info("Clean up data usage for all devices...");

    const macs = hostManager.getActiveMACs();
    for(const mac of macs) {
      await tracking.cleanup(mac);
    }

    log.info("Clean up data usage for all devices is complete");
  }

  run() {
    setInterval(() => {
      this.scheduledJob();
    }, this.interval);

    setInterval(() => {
      this.cleanupJob();
    }, this.cleanupInterval);
  }
}

module.exports = AccountingPlugin;
