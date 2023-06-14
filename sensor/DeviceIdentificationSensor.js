/*    Copyright 2023 Firewalla Inc.
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
const rclient = require('../util/redis_manager.js').getRedisClient()
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const config = require('../net2/config.js')
const sem = require('./SensorEventManager.js').getInstance();

class DeviceIdentificationSensor extends Sensor {

  async job() {
    const hosts = await hostManager.getHostsAsync()

    const now = Date.now() / 1000
    const expire = config.get('bro.userAgent.expires')

    for (const host of hosts) try {
      const key = `host:user_agent2:${host.o.mac}`

      const results = await rclient.zrevrangebyscoreAsync(key, now, now - expire)
      const deviceType = {};
      const deviceName = {};
      const osFamily = {};

      for (const result of results) try {
        const r = JSON.parse(result);

        if (r.device && r.device.type) {
            this.incr(deviceType, r.device.type)
        }

        const nameArray = []
        r.device && r.device.brand && nameArray.push(r.device.brand)
        if (r.device && r.device.model)
          nameArray.push(r.device.model)
        else if (r.os && r.os.family)
          nameArray.push(r.os.family == 'iOS' ? 'iPhone' : r.os.family)
        nameArray.length && this.incr(deviceName, nameArray.join(' ').trim())

        if (r.os && r.os.family)
          this.incr(osFamily, r.os.family)

      } catch(err) {
        log.error('Error reading user agent', result, err)
      }

      log.debug('device', host.o.mac)
      const type = Object.keys(deviceType).sort((a, b) => deviceType[b] - deviceType[a])[0]
      log.debug('choosen type', type, deviceType)
      const name = Object.keys(deviceName).sort((a, b) => deviceName[b] - deviceName[a])[0]
      log.debug('choosen name', name, deviceName)
      const os = Object.keys(osFamily).sort((a, b) => osFamily[b] - osFamily[a])[0]
      log.debug('choosen os', os, osFamily)

      host.o.detect = { type, name, os }
      await host.save('detect')
    } catch(err) {
      log.error('Error identifying device', host.o.mac, err)
    }
  }

  incr(counter, key) {
    if (counter[key])
      counter[key] ++
    else
      counter[key] = 1
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      this.job();
      setInterval(() => {
        this.job();
      }, (this.config.interval || 60 * 60) * 1000)
    });
  }
}

module.exports = DeviceIdentificationSensor;
