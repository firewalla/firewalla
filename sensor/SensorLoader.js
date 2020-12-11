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
const config = require('../net2/config.js').getConfig();
const fireRouter = require('../net2/FireRouter.js')

const sensors = [];
const sensorsHash = {}

function initSingleSensor(sensorName) {
  let sensorConfigs = config.sensors;

  if (!sensorConfigs || !sensorConfigs[sensorName] ||
      sensorConfigs[sensorName].enable === false ||   // undefined should not be counted
      sensorConfigs[sensorName].disable
  ) {
    log.warn(`${sensorName} disabled`)
    return null;
  }

  try {
    let fp = './' + sensorName + '.js';
    let s = require(fp);
    let ss = new s();
    ss.setConfig(sensorConfigs[sensorName]);
    sensors.push(ss);
    sensorsHash[sensorName] = ss
    return ss
  } catch(err) {
    log.error(`Failed to load sensor: ${sensorName}: ${err}`)
    return null
  }
}

async function initSensors() {
  await fireRouter.waitTillReady()

  Object.keys(config.sensors).forEach((sensorName) => {
    if (!sensorsHash[sensorName] && config.sensors[sensorName].disable !== true)
      initSingleSensor(sensorName)
  });
}

function run() {
  sensors.forEach((s) => {
    log.info("Installing Sensor:", s.constructor.name);
    try {
      s.run()
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
  initSingleSensor:initSingleSensor,
  run:run,
  getSensor: getSensor
};
