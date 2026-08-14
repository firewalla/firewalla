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
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const fc = require('../net2/config.js');
const Constants = require('../net2/Constants.js');

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

    sclient.subscribe("alarm:pending");
    sclient.subscribe("alarm:activated");
    sclient.on("message", (channel, message) => {
      switch (channel) {
        case "alarm:pending": {
          this.notifyMspNewAlarm("alarms:pending", message)
              .catch(err => log.error("Failed to notify msp on pending alarm", err));
          break;
        }
        case "alarm:activated": {
          this.notifyMspNewAlarm("alarms:new", message)
              .catch(err => log.error("Failed to notify msp on new alarm", err));
          break;
        }
        default:
          break;
      }
    })

  }

  async notifyMspNewAlarm(item, message) {
    if (!fc.isFeatureOn(Constants.FEATURE_MSP_SYNC_OPS)) {
      return;
    }
    const aid = JSON.parse(message).aid;
    if (!aid) {
      return;
    }
    const gs = require('./APISensorLoader.js').getSensor('GuardianSensor');
    if (!gs) {
      return;
    }
    log.info("Notifying msp of new alarm", item, aid);
    await gs.enqueueOpToMsp({
      mtype: "cmd",
      data: {
        item: item,
        value: {aids: [aid]}
      },
      type: "jsonmsg",
      ts: Date.now() / 1000
    })
  }
}

module.exports = AlarmSensor;
