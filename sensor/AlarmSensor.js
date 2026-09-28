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
const rclient = require('../util/redis_manager.js').getRedisClient();
const fc = require('../net2/config.js');
const Constants = require('../net2/Constants.js');

const am2 = new AlarmManager2();

const MSP_ALARM_OP_ITEMS = ["alarms:pending", "alarms:new"];
const MSP_ALARM_OP_INTERVAL = 5 * 60 * 1000; // batch queued alarm ids to msp every 5 minutes
// aids queue in redis rather than in memory, so a restart or a reboot does not drop them
const alarmOpQueueKey = (item) => `msp:alarm:op:${item}`;


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
          this.queueAlarmForMsp("alarms:pending", message)
              .catch(err => log.error("Failed to queue pending alarm for msp", err));
          break;
        }
        case "alarm:activated": {
          this.queueAlarmForMsp("alarms:new", message)
              .catch(err => log.error("Failed to queue new alarm for msp", err));
          break;
        }
        default:
          break;
      }
    })

    setInterval(() => {
      this.notifyMspQueuedAlarms()
          .catch(err => log.error("Failed to notify msp of queued alarms", err));
    }, MSP_ALARM_OP_INTERVAL);

  }

  async queueAlarmForMsp(item, message) {
    if (!fc.isFeatureOn(Constants.FEATURE_MSP_SYNC_OPS)) {
      return;
    }
    const aid = JSON.parse(message).aid;
    if (!aid) {
      return;
    }
    await rclient.saddAsync(alarmOpQueueKey(item), aid);
  }

  async notifyMspQueuedAlarms() {
    const gs = require('./APISensorLoader.js').getSensor('GuardianSensor');
    if (!gs) {
      return;
    }
    for (const item of MSP_ALARM_OP_ITEMS) {
      const key = alarmOpQueueKey(item);
      const aids = await rclient.smembersAsync(key);
      if (!aids.length) {
        continue;
      }
      log.info("Notifying msp of alarms", item, aids);
      await gs.enqueueOpToMsp({
        mtype: "cmd",
        data: {
          item: item,
          value: {aids: aids}
        },
        type: "jsonmsg",
        ts: Date.now() / 1000
      })
      // drop only what was queued, so an alarm arriving meanwhile waits for the next round
      await rclient.sremAsync(key, ...aids);
    }
  }
}

module.exports = AlarmSensor;
