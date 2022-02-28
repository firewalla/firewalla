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


let sensors = [];
let sensorsHash = {}

async function initSensors(eptcloud) {
  await fireRouter.waitTillReady()
  const sensorConfigs = (await Config.getConfig(true)).apiSensors;

  if(!sensorConfigs)
    return;

  Object.keys(sensorConfigs).forEach((sensorName) => {
    if (sensorsHash[sensorName] || sensorConfigs[sensorName].disable === true) return

    try {
      let fp = './' + sensorName + '.js';
      let s = require(fp);
      let ss = new s(sensorConfigs[sensorName]);
      ss.eptcloud = eptcloud;
      sensors.push(ss);
      sensorsHash[sensorName] = ss;
    } catch(err) {
      log.error(`Failed to load sensor: ${sensorName}:`, err)
    }
  });


  sclient.on("message", (channel, message) => {
    switch (channel) {
      case "config:updated": {
        const config = JSON.parse(message)
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
    log.info("Installing Sensor:", s.constructor.name);
    try {
      s.apiRun()
    } catch(err) {
      log.error(`Failed to install sensor: ${s.constructor.name}:`, err)
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
