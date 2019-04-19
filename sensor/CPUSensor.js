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

const Sensor = require('./Sensor.js').Sensor
const bone = require("../lib/Bone.js");

const fc = require('../net2/config.js')

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const FEATURE_BOOST = "cpu_boost";
const FEATURE_MONITOR = "cpu_monitor";

var high, low, lastReport;

class CPUSensor extends Sensor {
  constructor() {
    super();
  }

  async run() {
    if(fc.isFeatureOn(FEATURE_BOOST)) {
      await this.turnOn();
    } else {
      await this.turnOff();
    }

    fc.onFeature(FEATURE_BOOST, async (feature, status) => {
      if(feature != FEATURE_BOOST) {
        return;
      }

      if(status) {
        await this.turnOn();    
      } else {
        await this.turnOff();
      }
    })

    // only monitors blue for now
    if (platform.getName() === 'blue') {
      setInterval(() => {
        if (!fc.isFeatureOn(FEATURE_MONITOR)) return;

        this.checkTemperature();
      }, this.config.interval * 1000);
    }
  }

  async turnOn() {
    return platform.applyCPUBoostProfile();
  }

  async turnOff() {
    return platform.applyCPUDefaultProfile();
  }

  // send cloud log if CPU temperature exceeds threshold during report interval
  async checkTemperature() {
    try {
      let t = platform.getCpuTemperature();
      log.info("CPU Temperature:", t);
      let period = this.config.reportInterval;

      if (t > 0 && (!high || t > high)) high = t;
      if (t > 0 && (!low  || t < low))  low  = t;

      if (high > this.config.temperatureThreshold &&
        (!lastReport || lastReport + period * 1000 < Date.now())
      ) {
        let current = t;
        log.warn("CPU too hot, cloud alarm triggered", {current, high, low});
        await bone.logAsync("error",
          {
            version: fc.getConfig().version,
            type: 'FIREWALLA.CPUSensor.HighTemperature',
            msg: { period, high, low, current }
          }
        );

        high = undefined;
        low = undefined;
        lastReport = Date.now();
      }
    } catch(err) {
      log.error("Failed checking CPU temperature", err);
    }
  }
}

module.exports = CPUSensor;
