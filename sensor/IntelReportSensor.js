/*    Copyright 2016-2022 Firewalla Inc.
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

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();

const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();
  
const blackholePrefix = "blue:history:domain:blackhole:";

class IntelReportSensor extends Sensor {
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
        "p.device.ip": host.ipv4Addr,
        "p.device.mac": hostMac
      })

      await alarmManager2.enrichDeviceInfo(alarm);
      alarmManager2.enqueueAlarm(alarm);
    }
  }

  async generateBlackHoleAlarm2(total, domainCount, top10) {
    if(domainCount === 0) {
      return;
    }

    log.info(`Auto blocked ${domainCount} suspicious websites from attacking your network, ${total} attempts`);

    const alarm = new Alarm.IntelReportAlarm(new Date() / 1000, "0.0.0.0", {
      "p.attempts": total,
      "p.domainCount": domainCount,
      "p.top10": JSON.stringify(top10),
      "p.firstDomain": top10[0].domain
    })

    alarmManager2.enqueueAlarm(alarm);
  }
  
  async blackHoleHistory() {
    const keyPattern = `${blackholePrefix}*`;
    const hostKeys = await rclient.scanResults(keyPattern);
    
    log.info(`Found ${hostKeys.length} hosts had attack`);

    for (let i = 0; i < hostKeys.length; i++) {
      const hostKey = hostKeys[i];
      const hostMac = hostKey.replace(blackholePrefix, "");

      const beginDate = Math.floor(new Date() / 1000) - 24 * 3600;
      const domains = await rclient.zrangebyscoreAsync(hostKey, beginDate, '+inf')
      
      await this.generateBlackHoleAlarm(hostMac, domains).catch((err) => {
        log.error(`Failed to generate alarm on host ${hostMac}, err: ${err}`);
      });
    }
  }

  async blackHoleHistory2() {
    const dateKey = Math.floor(new Date() / 1000 / 3600 / 24) * 3600 * 24;
    const key = `${blackholePrefix}${dateKey}`;

    const domainMap = await rclient.hgetallAsync(key);

    if(!domainMap) {
      return;
    }

    let total = 0;

    const domains = Object.keys(domainMap);
    const domainCount = domains.length;

    log.info(`Found attacks from ${domains.length} domains`);

    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      total += Number(domainMap[domain]);
    }

    const top10 = domains.map((domain) => {
      return {
        domain: domain,
        count: domainMap[domain]
      };
    }).sort((x, y) => {
      if(x.count > y.count) {
        return 1;
      } else if(x.count < y.count) {
        return -1;
      } else {
        return 0;
      }
    }).slice(0,10)

    await this.generateBlackHoleAlarm2(total, domainCount, top10).catch((err) => {
      log.error(`Failed to generate daily report alarm, err: ${err}`);
    });
  }
  
  job() {
    
  }
  
  run() {
    sem.on("BLACK_HOLE_ALARM", (event) => {
      this.blackHoleHistory2();
    })
  }
}

module.exports = IntelReportSensor;
