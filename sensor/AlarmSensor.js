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

const sem = require('./SensorEventManager.js').getInstance();

const extensionManager = require('./ExtensionManager.js')
const Sensor = require('./Sensor.js').Sensor;

const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js')
const am2 = new AlarmManager2();

class AlarmSensor extends Sensor {
  constructor(config) {
    super(config);
  }

  async apiRun() {
    extensionManager.onCmd("alarm:create", async (msg, data) => {
      await this._genAlarm(data);
    });
  }

  async _genAlarm(options = {}) {
    const type = options.type;
    const ip = options["p.device.ip"];

    if(!type || !ip) {
      log.info("require type and ip");
      return;
    }

    let alarm = null;

    switch (type) {
      case "ALARM_INTEL":
        alarm = new Alarm.IntelAlarm(new Date() / 1000, ip, "major", options);
        break;
      case "ALARM_VIDEO":
        alarm = new Alarm.VideoAlarm(new Date() / 1000, ip, "major", options);
        break;
    }

    await am2.enrichDeviceInfo(alarm);
    am2.enqueueAlarm(alarm); // use enqueue to ensure no dup alarms
  }
}

module.exports = AlarmSensor;
