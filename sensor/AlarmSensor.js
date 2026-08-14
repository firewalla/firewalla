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

const MSP_ALARM_OP_KEY = 'msp:alarm:op:ts';
const MSP_ALARM_OP_INTERVAL = 300; // notify msp at most once every 5 minutes


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

    // FireMain publishes this once per real inactive-to-active transition
    sclient.subscribe("alarm:activated");
    sclient.on("message", (channel, message) => {
      switch (channel) {
        case "alarm:activated": {
          this.notifyMspNewAlarm(message)
              .catch(err => log.error("Failed to notify msp on new alarm", err));
          break;
        }
        default:
          break;
      }
    })

  }

  async notifyMspNewAlarm(message) {
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

    const fresh = await rclient.setAsync(MSP_ALARM_OP_KEY, Date.now(), 'NX', 'EX', MSP_ALARM_OP_INTERVAL);
    if (!fresh) {
      return;
    }

    log.info("Notifying msp of new alarm", aid);
    try {
      await gs.enqueueOpToMsp({
        mtype: "cmd",
        data: {
          item: "alarm:new",
          value: {aid: aid}
        },
        type: "jsonmsg",
        ts: Date.now() / 1000
      })
    } catch (err) {
      // nothing was queued, so release the throttle for the next alarm
      await rclient.unlinkAsync(MSP_ALARM_OP_KEY).catch(() => undefined);
      throw err;
    }
  }
}

module.exports = AlarmSensor;
