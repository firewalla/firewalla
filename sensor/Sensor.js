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

let log = require('../net2/logger.js')(__filename);

const extensionManager = require('./ExtensionManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();
const fc = require('../net2/config.js');


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
      if (fc.isFeatureOn(featureName)) {
        await this.globalOn();
      } else {
        await this.globalOff();
      }
      fc.onFeature(featureName, async (feature, status) => {
        if (feature !== featureName) {
          return;
        }
        if (status) {
          await this.globalOn();
        } else {
          await this.globalOff();
        }
      })

      await this.job();
      if (this.refreshInterval) {
        this.timer = setInterval(async () => {
          return this.job();
        }, this.refreshInterval);
      }

    })
  }

  async job() {

  }

};

module.exports = {
  FWEvent: FWEvent,
  Sensor: Sensor
}
