/*    Copyright 2021 Firewalla Inc.
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

const flowTool = require('../net2/FlowTool');
const log = require('../net2/logger.js')(__filename)
const _ = require('lodash');
const Sensor = require('./Sensor.js').Sensor
const fc = require('../net2/config.js');
const featureName = 'compress_flows'
const Promise = require('bluebird');
const zlib = require('zlib');
const extensionManager = require('./ExtensionManager.js')
const { rclient } = require('../util/redis_manager');
const deflateAsync = Promise.promisify(zlib.deflate);
const sem = require('./SensorEventManager.js').getInstance();
const MAX_MEM = 10 * 1000 * 1000

class FlowCompressionSensor extends Sensor {
  constructor() {
    super()
    this.recentlyTickKey = "compressed:flows:lastest:ts"
    this.step = 60 * 60 // one hour
    this.maxInterval = 24 * 60 * 60 // 24 hours
  }

  async run() {
    sem.once('IPTABLES_READY', async () => {
      await this.build()
      setInterval(async () => {
        await this.build()
      }, 30 * 60 * 1000);
    })
  }

  async checkAndCleanMem() {
    let compressedMem = 0
    let oldestKey
    const compressedFlowsKeys = await rclient.scanResults(this.getKey("*", "*"), 1000)
    for (const key of compressedFlowsKeys) {
      const mem = Number(await rclient.memoryAsync("usage", key) || 0)
      compressedMem += mem
      if (!oldestKey) {
        oldestKey = key
      } else if (await rclient.ttlAsync(key) < await rclient.ttlAsync(oldestKey)) {
        oldestKey = key
      }
    }
    if (compressedMem > MAX_MEM) { // del the oldest key
      await rclient.delAsync(oldestKey)
    }
  }

  async apiRun() {
    extensionManager.onGet("compressedflows", (msg, data) => {
      return this.loadCompressedFlows(data)
    });
  }

  async loadCompressedFlows(options) {
    // options {begin,end}
    let { begin, end } = options
    begin = begin - begin % this.step
    end = end - end % this.step
    log.info(`Load compressed flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    const compressedFlows = []
    for (let i = 0; i < (end - begin) / this.step; i++) {
      const beginTs = begin + this.step * i
      const endTs = begin + this.step * (i + 1)
      const str = await rclient.getAsync(this.getKey(beginTs, endTs))
      str && compressedFlows.push(str)
    }
    return compressedFlows
  }

  getKey(begin, end) {
    return `compressed:flows:${begin}:${end}`
  }

  async sensorCheck() {
    if (!fc.isFeatureOn(featureName)) {
      log.info(`${featureName} feature is disabled.`)
      return false
    }
    const members = await rclient.smembersAsync("sys:ept:members")
    if (members && members.length > 0) {
      const webEnabled = members.map((m) => {
        try {
          return JSON.parse(m)
        } catch (err) {
          return null
        }
      }).filter((x) => x != null && x.name == 'firewalla_web').length > 0
      if (!webEnabled) {
        log.info(`firewalla_web haven't enabled`)
      }
      return webEnabled
    }
    return false
  }

  async build() {
    try {
      if (! await this.sensorCheck()) return
      const { begin, end } = await this.getBuildingWindow()
      const now = new Date() / 1000
      log.info(`Going to compress flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
      for (let i = 0; i < (end - begin) / this.step; i++) {
        const beginTs = begin + this.step * i
        const endTs = begin + this.step * (i + 1)
        const flows = await this.loadFlows(beginTs, endTs)
        await this.save(beginTs, endTs, flows)
      }
      await rclient.setAsync(this.recentlyTickKey, end)
      log.info(`Compressed flows build complted, cost ${(new Date() / 1000 - now).toFixed(2)}`)
    } catch (e) {
      log.error(`Compress flows error`, e)
    }
  }

  async save(begin, end, flows) { // might save to disk in future
    const base64Str = await this.compress(flows)
    const key = this.getKey(begin, end)
    await rclient.setAsync(key, base64Str)
    await rclient.expireatAsync(key, end + this.maxInterval)
    await this.checkAndCleanMem()
  }

  async getBuildingWindow() {
    const now = new Date() / 1000
    const nowTickTs = now - now % this.step
    let recentlyTickTs = Number(await rclient.getAsync(this.recentlyTickKey) || 0)
    if (nowTickTs - recentlyTickTs > this.maxInterval) {
      recentlyTickTs = nowTickTs - this.maxInterval
    }
    return {
      begin: recentlyTickTs,
      end: nowTickTs
    }
  }

  async loadFlows(begin, end) {
    log.info(`Going to load flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    let completed = false
    const options = {
      begin: begin,
      end: end,
      audit: true,
      count: 2000,
      asc: true
    }
    let allFlows = []
    const now = new Date() / 1000
    while (!completed) {
      try {
        const flows = await flowTool.prepareRecentFlows({}, JSON.parse(JSON.stringify(options))) || []
        if (flows.length < options.count) {
          completed = true
        } else {
          options.begin = flows[flows.length - 1].ts
        }
        allFlows = allFlows.concat(flows)
      } catch (e) {
        log.error(`Load flows error`, e)
        completed = true
      }
    }
    log.debug(`get ${allFlows.length} flows cost ${(new Date() / 1000 - now).toFixed(2)} seconds`)
    // debug purpose
    log.debug(`there are ${allFlows.reduce((ac, val) => ac + val.count, 0)} zeek logs for these flows`)
    return allFlows
  }

  mergeFlows(flows) {
    if (!flows || flows.length == 0) return [];
    let stash = flows[0];
    const mergedFlows = [stash];
    const compareKeys = ["ltype", "fd", "device", "protocol", "host", "ip", "domain"]
    for (var i = 1; i < flows.length; i++) {
      const flow = flows[i]
      if (_.isEqual(_.pick(stash, compareKeys), _.pick(flow, compareKeys))) {
        stash.count += flow.count
        stash.download += flow.download
        stash.upload += flow.upload
        stash.duration += flow.duration
      } else {
        stash = flow
        mergedFlows.push(stash)
      }
    }
    return mergedFlows
  }
  async compress(flows) {
    const mergedFlows = this.mergeFlows(flows)
    const str = JSON.stringify(mergedFlows)
    const deflateBuffer = await deflateAsync(str)
    const base64Str = deflateBuffer.toString('base64')
    log.debug(`Compress ${mergedFlows.length} flows, raw: ${str.length} deflate: ${deflateBuffer.length} base64:${base64Str.length}`)
    return base64Str
  }
}


module.exports = FlowCompressionSensor;