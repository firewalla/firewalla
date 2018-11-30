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

const fc = require('../net2/config.js')

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const featureName = "cpu_boost";

class CPUSensor extends Sensor {
  constructor() {
    super();
  }

  async run() {
    if(fc.isFeatureOn(featureName)) {
      await this.turnOn();
    } else {
      await this.turnOff();
    }

    fc.onFeature(featureName, async (feature, status) => {
      if(feature != featureName) {
        return;        
      }
            
      if(status) {
        await this.turnOn();    
      } else {
        await this.turnOff();
      }
    })          
  }

  async turnOn() {
    return platform.applyCPUBoostProfile();
  }

  async turnOff() {
    return platform.applyCPUDefaultProfile();
  }
}

module.exports = CPUSensor;
