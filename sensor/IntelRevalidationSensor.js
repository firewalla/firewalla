/*    Copyright 2019 Firewalla LLC
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

const rclient = require('../util/redis_manager.js').getRedisClient();

const Promise = require('bluebird');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

class IntelRevalidationSensor extends Sensor {

  async run() {
    setTimeout(() => {
      this.frequentJob();

      setInterval(() => {
        this.frequentJob();
      }, this.config.frequentJobInterval || 15 * 60 * 1000); // by default every 15 minutes
    }, this.config.initialFrequentJobTime || 5 * 60 * 1000); // at beginning, start after 5 minutes
  }

  async frequentJob() {
    await intelTool.updateSecurityIntelTracking("_");
    return this.revalidateSecurityIntels();
  }

  async iterateAllIntels(callback) {
    let cursor = 0;
    let stop = false;

    while(stop !== true) {
      const result = await rclient.scanAsync(cursor, "MATCH", "intel:ip:*", "COUNT", 100);
      if(!result) {
        log.error("Unexpected error when scan intel ip in redis, return result is null");
        stop = true;
        return;
      }

      cursor = result[0];
      if(cursor === 0) {
        stop = true;
      }

      const keys = result[1];

      await Promise.all(keys.map(async key => {
        if(callback) {
          return callback(key);
        }
      }));
    }
  }

  async revalidateSecurityIntels() {
    const trackingKey = intelTool.getSecurityIntelTrackingKey();
    const exists = await rclient.existsAsync(trackingKey);
    if(exists !== 1) {
      await this.reconstructSecurityIntelTracking();
    }

    const intelKeys = await rclient.zrangeAsync(trackingKey, 0, -1);

    for(const intelKey of intelKeys) {
      if(!intelKey.startsWith("intel:ip:")) {
        continue;
      }

      const exists = await rclient.existsAsync(intelKey);
      const ip = intelKey.replace("intel:ip:", "");
      log.info(`Revalidating intel for IP ${ip} ...`);
      sem.emitEvent({
        type: 'DestIP',
        skipLocalCache: true,
        ip: ip
      });
    }

  }

  async revalidateAllIntels() {
    // TODO
  }

  async reconstructSecurityIntelTracking() {
    await this.iterateAllIntels(async (intelKey) => {
      const category = await rclient.hgetAsync(intelKey, "category");
      if(category === 'intel') {
        await intelTool.updateSecurityIntelTracking(intelKey);
      }
    });
    await intelTool.updateSecurityIntelTracking("_");
  }

}

module.exports = IntelRevalidationSensor;
