/*    Copyright 2022 Firewalla Inc.
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

const extensionManager = require('./ExtensionManager.js')
const Sensor = require('./Sensor.js').Sensor;

const AlarmManager2 = require('../alarm/AlarmManager2.js')
const pclient = require('../util/redis_manager.js').getPublishClient();

const am2 = new AlarmManager2();


class AlarmSensor extends Sensor {
  constructor(config) {
    super(config);
  }

  async apiRun() {
    // data: {type: ALARM_XX, timestamp: optional, device: optional, info:{}}
    extensionManager.onCmd("alarm:create", async (msg, data) => {
      if (!am2.isAlarmSyncMspEnabled()) {
        return {err: "alarm sync msp disabled"};
      }

      if (!data || !data.type) {
        return {err: "must specify alarm type"};
      }

      data['p.createFrom'] = 1; // 1 for msp
      await pclient.publishAsync("alarm:create", JSON.stringify(data));
        
      return {ok: true};
    });

    // data: {'apply':[ alarm: {aid: XX, state: 0} ]};
    extensionManager.onCmd('alarm:mspsync', async(msg, data) => {
      if (!am2.isAlarmSyncMspEnabled()) {
        return {err: "feature disabled"};
      }
      await pclient.publishAsync("alarm:mspsync", JSON.stringify(data));
      return {ok: true};
    });
  }
}

module.exports = AlarmSensor;
