/*    Copyright 2023-2024 Firewalla Inc.
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
const bone = require("../lib/Bone.js");
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const TagManager = require('../net2/TagManager.js');
const Constants = require('../net2/Constants.js');
const config = require('../net2/config.js')
const sm = require('../net2/SysManager.js')
const Host = require('../net2/Host.js')
const httpFlow = require('../extension/flow/HttpFlow.js');
const sem = require('./SensorEventManager.js').getInstance();
const { getPreferredName } = require('../util/util.js')
const { nameToType } = require('../extension/detect/common.js')

const _ = require('lodash')

const FEATURE_NAME = 'device_detect'


class DeviceIdentificationSensor extends Sensor {

  async job() {
    log.info('Identifying local devices ...')
    const hosts = await hostManager.getHostsAsync()

    this.now = Date.now() / 1000
    this.expire = config.get('bro.userAgent.expires')

    for (const host of hosts) try {
      // keep user feedback and other detection sources
      const keepsake = _.pick(host.o.detect, ['feedback', 'bonjour', 'cloud'])

      host.o.detect = await this.detect(host)

      Object.assign(host.o.detect, keepsake)
      await this.mergeAndSave(host)
    } catch(err) {
      log.error('Error identifying device', host.o.mac, err)
    }
  }

  async detect(host) {
    if (host instanceof Host && sm.isFirewallaMac(host.o.mac)) {
      log.debug('Found Firewalla device', host.o.mac)
      return { name: 'Firewalla' }
    }

    const name = getPreferredName(host.o)
    if (name) {
      const type = await nameToType(name)
      if (type) {
        log.debug('Type from name', host.o.mac, name, type)
        return { type }
      }
    }

    const key = `host:user_agent2:${host.o.mac}`
    const results = await rclient.zrevrangebyscoreAsync(key, this.now, this.now - this.expire).map(JSON.parse)

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
    const deviceBrand = {};
    const deviceModel = {};
    const osName = {};

    for (const r of results) try {
      if (r.device) {
        if (r.device.type) {
          if (['smartphone', 'feature phone', 'phablet'].includes(r.device.type)) {
            r.device.type = 'phone'
          }
          this.incr(deviceType, r.device.type)
        }
        r.device.model && this.incr(deviceModel, r.device.model)
        r.device.brand && this.incr(deviceBrand, r.device.brand)
      }

      if (r.os && r.os.name)
        this.incr(osName, r.os.name)

    } catch(err) {
      log.error('Error reading user agent', r, err)
    }

    const detect = {}
    log.debug('device', host.o.mac)
    if (Object.keys(deviceType).length > 3 || Object.keys(osName).length > 5) {
      log.debug('choosen type: router', deviceType, osName)
      detect.type = 'router'
    } else {
      const type = _.get(_.maxBy(Object.entries(deviceType), 1), 0)
      log.debug('choosen type', type, deviceType)
      const brand = _.get(_.maxBy(Object.entries(deviceBrand), 1), 0)
      log.debug('choosen brand', brand, deviceBrand)
      const model = _.get(_.maxBy(Object.entries(deviceModel), 1), 0)
      log.debug('choosen model', model, deviceModel)
      const os = _.get(_.maxBy(Object.entries(osName), 1), 0)
      log.debug('choosen os', os, osName)

      if (type) detect.type = type;
      if (brand) detect.brand = brand;
      if (model) detect.model = model;
      if (os)   detect.os = os;
    }

    return detect
  }

  incr(counter, key) {
    if (counter[key])
      counter[key] ++
    else
      counter[key] = 1
  }

  async mergeAndSave(host) {
    const detect = host.o.detect
    if (!Object.keys(detect)) return

    Object.assign(detect, detect.bonjour, detect.cloud)
    log.debug('Saving', host.o.mac, detect)
    await host.save('detect')

    const type = detect.feedback && detect.feedback.type || detect.type
    if (type) {
      log.verbose(`Applying ${type} tag to ${host.getUniqueId()}`)
      let tag = await TagManager.getTagByName(type, Constants.TAG_TYPE_DEVICE);
      if (!tag)
        tag = await TagManager.createTag(type, { type: Constants.TAG_TYPE_DEVICE })
      // policy should be loaded at this point
      const policyKey = Constants.TAG_TYPE_MAP[Constants.TAG_TYPE_DEVICE].policyKey
      // overwrites previous tags
      await host.setPolicyAsync(policyKey, [tag.getUniqueId()])
    }
  }

  run() {
    this.hookFeature(FEATURE_NAME)

    sem.on('DetectUpdate', async (event) => {
      if (!config.isFeatureOn(FEATURE_NAME)) return

      try {
        const { mac, detect, from } = event
        log.verbose('DetectUpdate', mac, from, detect)

        if (mac && detect && from) {
          const host = await hostManager.getHostAsync(mac)
          if (!host) return
          if (!host.o.detect) host.o.detect = {}
          host.o.detect[from] = Object.assign({}, host.o.detect[from], detect)
          await this.mergeAndSave(host)
        }
      } catch(err) {
        log.error('Error saving result', event, err)
      }
    })
  }

  async checkList() {
    try {
      log.verbose('checking device type preload list ...')
      const hashset = await bone.hashsetAsync('device:type:list:preload')
      const types = JSON.parse(hashset)
      for (const type of types) {
        const tag = await TagManager.getTagByName(type, Constants.TAG_TYPE_DEVICE);
        if (!tag) {
          const tag = await TagManager.createTag(type, { type: Constants.TAG_TYPE_DEVICE })
          log.info('created preload device type tag', tag.getUniqueId(), tag.o.name)
        }
      }
    } catch(err) {
      log.error('Error creating preload device types', err)
    }
  }

  async globalOn() {
    if (!this.intervalTask)
      this.job()
      this.intervalTask = setInterval(() => {
        this.job();
      }, (this.config.interval || 60 * 60) * 1000)
    if (!this.intervalTaskListCheck)
      this.checkList()
      this.intervalTaskListCheck = setInterval(() => {
        this.checkList();
      }, (this.config.intervalListCheck || 24 * 60 * 60) * 1000)
  }

  async globalOff() {
    clearInterval(this.intervalTask)
    delete this.intervalTask
    clearInterval(this.intervalTaskListCheck)
    delete this.intervalTaskListCheck
  }
}

module.exports = DeviceIdentificationSensor;
