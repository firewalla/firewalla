/*    Copyright 2018 Firewalla LLC
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

const ip = require('ip');

const log = require('../net2/logger.js')(__filename);

const fc = require('../net2/config.js')
const fConfig = require('../net2/config.js').getConfig();
const Bone = require('../lib/Bone');
const Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient();

const sem = require('../sensor/SensorEventManager.js').getInstance();

const checkInterval = 4 * 60 * 60 * 1000; //4 hours

const featureName = "scisurf";

const ssClientManager = require('../extension/ss_client/ss_client_manager.js');

class SSClientSensor extends Sensor {
  run() {
    (async() => {
      if(fc.isFeatureOn(featureName)) {
        await this.turnOn();
      } else {
        await this.turnOff();
      }
      fc.onFeature(featureName, (feature, status) => {
        if(feature != featureName)
          return
        
        if(status) {
          this.turnOn()
        } else {
          this.turnOff()
        }
      })          
    })()
  }

  async turnOn() {
    this.client = ssClientManager.getSSClient();
    await client.start();
  }

  async turnOff() {
    await this.client.stop();
    this.client = null;
  }
}

module.exports = SSClientSensor;
