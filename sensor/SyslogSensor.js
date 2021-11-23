/*    Copyright 2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
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
const rclient = require('../util/redis_manager.js').getRedisClient();
const LogReader = require('../util/LogReader')

const syslogPath = '/var/log/syslog'

class SyslogSensor extends Sensor {
  async watchLog(line) {
    if (line.includes('NETDEV WATCHDOG')) {
      log.info('Caught:', line)
      // Nov 13 16:28:59 localhost kernel: [ 1996.626297@2] NETDEV WATCHDOG: eth1 (r8168): transmit queue 0 timed out
      await rclient.hmsetAsync('sys:log:netdev_watchdog', {
        ts: Date.now() / 1000,
        log: line
      })
    }
  }

  async run() {
    this.rejects = []
    this.logWatcher = new LogReader(syslogPath, true)
    this.logWatcher.on('line', this.watchLog.bind(this))
    this.logWatcher.watch()
  }
}

module.exports = SyslogSensor
