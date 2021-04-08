/*    Copyright 2016-2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor

const extensionManager = require('./ExtensionManager.js')

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const am2 = new AlarmManager2();

const sem = require('../sensor/SensorEventManager.js').getInstance();

class RemoteNotificationSensor extends Sensor {
  apiRun() {
    extensionManager.onCmd("testRemoteNotification", async (msg, data) => {
      if(data.alarmID) {
        const alarm = await am2.getAlarm(data.alarmID);
        if (!alarm) {
          log.error(`Invalid Alarm ID: ${data.alarmID})`);
        }
    
        sem.emitEvent({
          type: "Alarm:NewAlarm",
          message: "A new alarm is generated",
          alarmID: alarm.aid
        });
        
        log.info(`Send remote notification on alarm ${data.alarmID} for debugging purpose`);
      }
      return {};
    });
  }
}

module.exports = RemoteNotificationSensor;
