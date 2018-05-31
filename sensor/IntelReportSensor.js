/*    Copyright 2016 Firewalla LLC 
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

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const Promise = require('bluebird');

const CronJob = require('cron').CronJob;

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();

const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();
  
const blackholePrefix = "blue:history:domain:blackhole:";

class IntelReportSensor extends Sensor {
  constructor() {
    super();
  }
  
  async generateBlackHoleAlarm(hostMac, domains) {
    if(domains.length === 0) {
      return;
    }
    
    const host = await hostTool.getMACEntry(hostMac);
    if(host) {
      const hostname = hostTool.getHostname(host);
      log.info(`Auto blocked ${domains.length} suspicious websites from accessing ${hostname}`);

      const alarm = new Alarm.IntelReportAlarm(new Date() / 1000, hostMac, {
        "p.num_of_domains": domains.length,
        "p.first10domains": JSON.stringify(domains.slice(0, 10)),
        "p.firstDomain": domains[0],
      })

      await alarmManager2.enrichDeviceInfo(alarm);
      await alarmManager2.checkAndSaveAsync(alarm);
    }
  }
  
  async blackHoleHistory() {
    const keyPattern = `${blackholePrefix}*`;
    const hostKeys = await rclient.keysAsync(keyPattern);

    for (let i = 0; i < hostKeys.length; i++) {
      const hostKey = hostKeys[i];
      const hostMac = hostKey.replace(blackholePrefix, "");

      const beginDate = Math.floor(new Date() / 1000);
      const domains = await rclient.zrangebyscoreAsync(hostKey, beginDate, '+inf')
      
      await this.generateBlackHoleAlarm(hostMac, domains).catch((err) => {
        log.error(`Failed to generate alarm on host ${hostMac}, err: ${err}`);
      });
    }
  }
  
  job() {
    
  }
  
  run() {
    sem.on("BLACK_HOLE_ALARM", (event) => {
      this.blackHoleHistory();
    })
  }
}

module.exports = IntelReportSensor;
