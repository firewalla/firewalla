/*    Copyright 2018 Firewalla INC
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

const ip = require('ip');

const log = require('../net2/logger.js')(__filename);

const fc = require('../net2/config.js')
const fConfig = require('../net2/config.js').getConfig();
const Bone = require('../lib/Bone');
const Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient();

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Alarm = require('../alarm/Alarm');
const AlarmManager2 = require('../alarm/AlarmManager2');
const am2 = new AlarmManager2();

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const checkInterval = 4 * 60 * 60 * 1000; //4 hours

const ALARM_SUBNET = 'alarm_subnet';

class SubnetSensor extends Sensor {
  async scheduledJob() {
    let detectedInterfaces = await rclient.hgetallAsync('sys:network:info');

    if (fConfig.discovery && fConfig.discovery.networkInterfaces) {
      for (const interfaceName of fConfig.discovery.networkInterfaces) {
        if (!detectedInterfaces[interfaceName]) continue;

        let intf = JSON.parse(detectedInterfaces[interfaceName]);
        if (intf && intf.subnet) {
          let subnet = ip.cidrSubnet(intf.subnet);
          let subnetCap = platform.getSubnetCapacity();
          if (subnet.subnetMaskLength < subnetCap) {
            let alarm = new Alarm.SubnetAlarm(
              new Date() / 1000,
              intf.gateway,
              {
                'p.device.ip': intf.gateway,
                'p.subnet.length': subnet.subnetMaskLength
              }
            );

            am2.enqueueAlarm(alarm);
            log.info('Created a subnet alarm', alarm.aid, 'for subnet', intf.subnet);
          }
        }
      };
    }
  }

  run() {
    setInterval(() => {
      if (fc.isFeatureOn(ALARM_SUBNET)) {
        this.scheduledJob();
      }
    }, checkInterval);
  }
}

module.exports = SubnetSensor;
