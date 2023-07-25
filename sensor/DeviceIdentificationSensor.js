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
const sm = require('../net2/SysManager.js')
const Host = require('../net2/Host.js')
const httpFlow = require('../extension/flow/HttpFlow.js');
const sem = require('./SensorEventManager.js').getInstance();

const _ = require('lodash')

const FEATURE_NAME = 'device_detect'

class DeviceIdentificationSensor extends Sensor {

  async job() {
    log.info('Identifying local devices ...')
    const hosts = await hostManager.getHostsAsync()

    const now = Date.now() / 1000
    const expire = config.get('bro.userAgent.expires')

    for (const host of hosts) try {
      if (host instanceof Host && sm.isFirewallaMac(host.o.mac)) {
        log.debug('Found Firewalla device', host.o.mac)
        host.o.detect = { name: 'Firewalla' }
        await host.save('detect')
        continue
      }

      const key = `host:user_agent2:${host.o.mac}`
      const results = await rclient.zrevrangebyscoreAsync(key, now, now - expire).map(JSON.parse)

      // parse legacy results to give detection an instant bootup
      if (httpFlow.detector) try {
        const oldKey = `host:user_agent:${host.o.mac}`
        const oldResults = await rclient.smembersAsync(oldKey)
        for (const result of oldResults) {
          const ua = JSON.parse(result).ua
          // should be fine not to dedup here
          results.push(httpFlow.detector.detect(ua))
        }
      } catch(err) {
        log.error('Error getting legacy user agents for', host.o.mac, err)
      }

      const deviceType = {};
      const deviceName = {};
      const osName = {};

      for (const r of results) try {
        if (r.device && r.device.type) {
          if (['smartphone', 'feature phone', 'phablet'].includes(r.device.type)) {
            r.device.type = 'phone'
          }
          this.incr(deviceType, r.device.type)
        }

        const nameArray = []
        r.device && r.device.brand && nameArray.push(r.device.brand)
        if (r.device && r.device.model)
          nameArray.push(r.device.model)
        else if (r.os && r.os.name)
          nameArray.push(r.os.name)
        nameArray.length && this.incr(deviceName, nameArray.join(' ').trim())

        if (r.os && r.os.name)
          this.incr(osName, r.os.name)

      } catch(err) {
        log.error('Error reading user agent', result, err)
      }


      // keep user feedback and other detection sources
      const keepsake = _.pick(host.o.detect, ['feedback', 'bonjour'])

      log.debug('device', host.o.mac)
      if (Object.keys(deviceType).length > 3 || Object.keys(osName).length > 5) {
        log.debug('choosen type: router', deviceType, osName)
        host.o.detect = { type: 'router' }
        if (host.o.macVendor) {
          host.o.detect.name = host.o.macVendor + ' Router'
        }
      } else {
        const type = Object.keys(deviceType).sort((a, b) => deviceType[b] - deviceType[a])[0]
        log.debug('choosen type', type, deviceType)
        const name = Object.keys(deviceName).sort((a, b) => deviceName[b] - deviceName[a])[0]
        log.debug('choosen name', name, deviceName)
        const os = Object.keys(osName).sort((a, b) => osName[b] - osName[a])[0]
        log.debug('choosen os', os, osName)

        host.o.detect = {}
        if (type) host.o.detect.type = type;
        if (name) host.o.detect.name = name;
        if (os) host.o.detect.os = os;
      }

      Object.assign(host.o.detect, keepsake)
      await this.mergeAndSave(host)
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

  async mergeAndSave(host) {
    const detect = host.o.detect
    if (Object.keys(detect)) {
      Object.assign(detect, detect.bonjour)
      await host.save('detect')
    }
  }

  run() {
    this.hookFeature(FEATURE_NAME)

    sem.on('DetectUpdate', async (event) => {
      if (!config.isFeatureOn(FEATURE_NAME)) return

      try {
        const { mac, detect, from } = event

        if (mac && detect && from) {
          const host = await hostManager.getHostAsync(mac)
          if (!host) return
          if (!host.o.detect) host.o.detect = {}
          host.o.detect[from] = detect
          await this.mergeAndSave(host)
        }
      } catch(err) {
        log.error('Error saving result', event, err)
      }
    })
  }

  async globalOn() {
    if (!this.IntervalTask)
      this.intervalTask = setInterval(() => {
        this.job();
      }, (this.config.interval || 60 * 60) * 1000)
  }

  async globalOff() {
    clearInterval(this.intervalTask)
    delete this.intervalTask
  }
}

module.exports = DeviceIdentificationSensor;
