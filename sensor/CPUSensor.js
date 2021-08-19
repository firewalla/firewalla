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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor
const bone = require("../lib/Bone.js");

const fc = require('../net2/config.js')

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const FEATURE_MONITOR = "cpu_monitor";

const high = [];
const low = []
let lastReport;

class CPUSensor extends Sensor {
  async run() {
    // only monitors blue for now
    if (platform.getName() === 'blue') {
      setInterval(() => {
        if (!fc.isFeatureOn(FEATURE_MONITOR)) return;

        this.checkTemperature();
      }, this.config.interval * 1000);
    }
  }
  // send cloud log if CPU temperature exceeds threshold during report interval
  async checkTemperature() {
    try {

      let tempList = await platform.getCpuTemperature();
      if (!Array.isArray(tempList)) tempList = [ tempList ] // wrap blue/red data

      for (let i in tempList) {
        const t = tempList[i]
        log.info(`CPU#${i} Temperature:`, t);
        let period = this.config.reportInterval;

        if (t > 0 && (!high[i] || t > high[i])) high[i] = t;
        if (t > 0 && (!low[i]  || t < low[i]))  low[i]  = t;

        if (high[i] > this.config.temperatureThreshold &&
          (!lastReport || lastReport + period * 1000 < Date.now())
        ) {
          let current = t;
          log.warn("CPU too hot, cloud alarm triggered", {current, high, low});
          await bone.logAsync("error",
            {
              type: 'FIREWALLA.CPUSensor.HighTemperature',
              msg: {
                period,
                high: high[i],
                low: low[i],
                current,
                highList: high,
                lowList: low,
                currentList: tempList
              }
            }
          );

          high[i] = undefined;
          low[i] = undefined;
          lastReport = Date.now();
        }
      }

    } catch(err) {
      log.error("Failed checking CPU temperature", err);
    }
  }
}

module.exports = CPUSensor;
