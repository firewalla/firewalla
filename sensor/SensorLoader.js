/*    Copyright 2016-2022 Firewalla Inc.
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
const Config = require('../net2/config.js');
const fireRouter = require('../net2/FireRouter.js')
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const sensors = [];
const sensorsHash = {}

async function initSingleSensor(sensorName, config) {
  const sensorConfigs = (config || await Config.getConfig(true)).sensors

  if (!sensorConfigs || !sensorConfigs[sensorName] ||
      sensorConfigs[sensorName].enable === false ||   // undefined should not be counted
      sensorConfigs[sensorName].disable
  ) {
    log.warn(`${sensorName} disabled`)
    return null;
  }

  if (sensorsHash[sensorName]) return sensorsHash[sensorName]

  log.info("Installing Sensor:", sensorName);

  try {
    let fp = './' + sensorName + '.js';
    let s = require(fp);
    let ss = new s(sensorConfigs[sensorName]);
    sensors.push(ss);
    sensorsHash[sensorName] = ss
    return ss
  } catch(err) {
    log.error('Failed to load sensor:', sensorName, err)
    return null
  }
}

async function initSensors() {
  await fireRouter.waitTillReady()

  const config = await Config.getConfig(true);

  Object.keys(config.sensors).forEach((sensorName) => {
    initSingleSensor(sensorName, config)
  });

  sclient.on("message", (channel, message) => {
    switch (channel) {
      case "config:updated": {
        // firemain sends this message so it's fine get the cache
        const config = Config.getConfig();
        for (const name of Object.keys(sensorsHash)) {
          const sensor = sensorsHash[name];
          const sensorConfig = config && config.sensors && config.sensors[name];
          if (sensorConfig)
            sensor.setConfig(sensorConfig);
        }
        break;
      }
      default:
    }
  });
  sclient.subscribe("config:updated");
}

function run() {
  sensors.forEach((s) => {
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
