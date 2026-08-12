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
const MSP_ALARM_OP_INTERVAL = 300; // notify msp at most once every 5*60 second


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

    sclient.subscribe("alarm:updateCache");
    sclient.on("message", (channel, message) => {
      switch (channel) {
        case "alarm:updateCache": {
          this.notifyMspNewAlarm(JSON.parse(message))
              .catch(err => log.error("Failed to notify msp on new alarm", err));
          break;
        }
        default:
          break;
      }
    })

  }

  async notifyMspNewAlarm(data) {
    if (!fc.isFeatureOn(Constants.FEATURE_MSP_SYNC_OPS)) {
      return;
    }
    const aids = data.aids || (data.aid ? [data.aid] : []);
    let activated;
    for (const aid of aids) {
      if (await am2.getAlarmState(aid) === Constants.ST_ACTIVATED) {
        activated = aid;
        break;
      }
    }

    if (!activated) {
      return;
    }

    // 5 minutes only have 1 op
    const fresh = await rclient.setAsync(MSP_ALARM_OP_KEY, Date.now(), 'NX', 'EX', MSP_ALARM_OP_INTERVAL);
    if (!fresh) {
      return;
    }

    const gs = require('./APISensorLoader.js').getSensor('GuardianSensor');
    if (!gs) {
      return;
    }
    log.info("Notifying msp of new alarm", activated);
    await gs.enqueueOpToMsp({
      mtype: "cmd",
      data: {
        item: "alarm:new",
        value: {aid: activated}
      },
      type: "jsonmsg",
      ts: Date.now() / 1000
    })

  }
}

module.exports = AlarmSensor;
