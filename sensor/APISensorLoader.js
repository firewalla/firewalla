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

let config = require('../net2/config.js').getConfig();

let sensors = [];
let sensorsHash = {}

function initSensors() {
  let sensorConfigs = config.apiSensors;

  if(!sensorConfigs)
    return;

  Object.keys(sensorConfigs).forEach((sensorName) => {
    try {
      let fp = './' + sensorName + '.js';
      let s = require(fp);
      let ss = new s();
      ss.setConfig(sensorConfigs[sensorName]);
      sensors.push(ss);
      sensorsHash[sensorName] = ss
    } catch(err) {
      log.error(`Failed to load sensor: ${sensorName}: ${err}`)
    }
  });  
}

function run() {
  sensors.forEach((s) => {
    log.info("Installing Sensor:", s.constructor.name, {});
    try {
      s.apiRun()
    } catch(err) {
      log.error(`Failed to install sensor: ${s.constructor.name}, err: ${err}`)
    }
  });
}

function getSensor(name) {
  return sensorsHash[name]
}

module.exports = {
  initSensors:initSensors,
  run:run,
  getSensor: getSensor
};
