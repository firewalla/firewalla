/*    Copyright 2020-2021 Firewalla Inc.
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

const sem = require('./SensorEventManager.js').getInstance()

const fc = require('../net2/config.js');

const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();

class OpenPortByInboundFlowSensor extends Sensor {
  run() {
    sem.on("NewOutPortConn", async (event) => {
      const flow = event.flow;
      if(!flow) {
        return;
      }

      //log.info(flow);
      if (fc.isFeatureOn("alarm_openport")) {
        let alarm = new Alarm.OpenPortAlarm(
          flow.ts,
          flow.mac,
          {
            'p.source': 'OpenPortByInboundFlowSensor',
            'p.device.ip': flow.lh,
            'p.device.mac': flow.mac,
            'p.open.port': flow.dp,
            'p.open.protocol': flow.pr
          }
        );
        await am2.enrichDeviceInfo(alarm);
        await am2.enqueueAlarm(alarm);
      }
    });
  }
}

module.exports = OpenPortByInboundFlowSensor;
