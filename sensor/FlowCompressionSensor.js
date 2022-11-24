/*    Copyright 2021-2022 Firewalla Inc.
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
const auditTool = require('../net2/AuditTool');
const log = require('../net2/logger.js')(__filename)
const _ = require('lodash');
const Sensor = require('./Sensor.js').Sensor
const featureName = 'compress_flows'
const Promise = require('bluebird');
const zlib = require('zlib');
const extensionManager = require('./ExtensionManager.js')
const rclient = require('../util/redis_manager').getRedisClient();
const deflateAsync = Promise.promisify(zlib.deflate);
const sem = require('./SensorEventManager.js').getInstance();
const delay = require('../util/util.js').delay;
const Queue = require('bee-queue');
const { Readable } = require('stream');
const SPLIT_STRING = "\n";
const CronJob = require('cron').CronJob;
const uuid = require('uuid');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const fc = require('../net2/config.js');
const sysManager = require('../net2/SysManager.js');
const Constants = require('../net2/Constants.js');

class FlowCompressionSensor extends Sensor {
  constructor() {
    super()
    this.maxCount = (this.config && this.config.maxCount * platform.getCompresseCountMultiplier()) || 10000
    this.maxMem = (this.config && this.config.maxMem * platform.getCompresseMemMultiplier()) || 20 * 1024 * 1024
    this.lastestTsKey = "compressed:flows:lastest:ts"
    this.wanCompressedFlowsKey = "compressed:wanblock:flows"
    this.buildingKey = "compressed:building"
    this.step = 60 * 60 // one hour
    this.maxInterval = 24 * 60 * 60 // 24 hours
    this.flowsType = ['normal', 'wanBlock']
    this.queueMap = {};
    this.streamMap = {};
    this.dumpingMap = {};
  }

  async run() {
    this.hookFeature(featureName);
    sem.on('Flow2Stream', (event) => {
      if (!fc.isFeatureOn(featureName)) {
        return
      }
      const { raw, audit, ftype = "normal" } = event;
      const queueObj = this.queueMap[ftype];
      if (queueObj) {
        const job = queueObj.createJob({ raw, audit });
        job.timeout(60000).retries(2).save((err) => {
          if (err) {
            log.error("Failed to create flows stream job", err.message);
          }
        })
      }
    })
    sem.on('AuditFlowsDrop', async () => {
      if (!this.featureOn) {
        return
      }
      // re-build wanBlock compressed flows
      try {
        await this.buildWanBlockCompressedFlows();
        const type = "wanBlock";
        const streamObj = this.streamMap[type];
        const queueObj = this.queueMap[type];
        this.dumpingMap[type] = true; // avoid stream.push() after EOF
        queueObj.destroy();
        streamObj.destroyStreams(); // destory and re-create
        this.setupStreams(type);
        this.setupFlowsQueue(type);
        this.dumpingMap[type] = false;
      } catch (e) {
        log.warn("re-build wanBlock compressed flows error", e)
      }
    })

    sem.on('DumpStreamFlows', async (event) => {
      const id = event.messageId;
      const now = new Date() / 1000;
      for (const type of this.flowsType) {
        await this.dumpStreamFlows(now, type);
      }
      sem.emitEvent({
        type: `DumpStreamFlows:Done-${id}`,
        toProcess: "FireApi",
        suppressEventLogging: false,
        message: "DumpStreamFlows:Done"
      })
    })

  }

  setupFlowsQueue(type) {
    const queueObj = new Queue(`${type}-flows-stream`, {
      removeOnFailure: true,
      removeOnSuccess: true
    })
    queueObj.on('error', (err) => {
      log.error("Queue got err:", err)
    })
    queueObj.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${job.action} failed with error ${err.message}`);
    });
    queueObj.destroy(() => {
      log.info(`${type} flows stream queue is cleaned up`)
    })
    queueObj.process(async (job, done) => {
      try {
        if (job && job.data) { // raw flow string
          const flow = await this.raw2Flow(job.data);
          const streamObj = this.streamMap[type];
          while (this.dumpingMap[type] || !streamObj) {
            log.debug("deferred due to readableStream might be destoryed and re-create");
            await delay(3000)
          }
          streamObj.readableStream.push(JSON.stringify(flow) + SPLIT_STRING)
        }
      } catch (e) {
        log.info("process job error", e);
      } finally {
        done();
      }
    })
    this.queueMap[type] = queueObj;
  }

  setupStreams(type) {
    const readableStream = new Readable({
      read() { }
    })
    const def = zlib.createDeflate();
    const zstream = readableStream.pipe(def);
    let chunks = [];
    const streamObj = {};
    streamObj.readableStream = readableStream;
    zstream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    zstream.on('error', (err) => {
      log.error("Stream deflate error", err);
      chunks = [];
    });
    streamObj.streamToStringAsync = new Promise((resolve) => zstream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('base64'))
    }))
    streamObj.destroyStreams = () => {
      readableStream.destroy();
      def.destroy();
      zstream.destroy();
    }
    this.streamMap[type] = streamObj;
  }

  async dumpStreamFlows(ts, type) {
    log.info(`Start dump ${type} stream data to redis`)
    const streamObj = this.streamMap[type];
    while (this.dumpingMap[type] || !streamObj) {
      await delay(1000)
    }
    this.dumpingMap[type] = true;
    try {
      if (streamObj.readableStream) {
        streamObj.readableStream.push(null); // readable stream EOF
        const result = await streamObj.streamToStringAsync; // dump the result to the redis
        await this.appendAndSave(ts, result, type);
        streamObj.destroyStreams(); // destory and re-create
        this.setupStreams(type);
      }
    } catch (e) {
      log.info("DumpStreamFlows error", e)
    }
    log.info("Dump stream data to redis done")
    this.dumpingMap[type] = false
  }

  async raw2Flow(message) {
    const { raw, audit } = message;
    let flow, enriched;
    if (audit) {
      flow = auditTool.toSimpleFormat(raw, {})
      flow.device = raw.mac
      enriched = await auditTool.enrichWithIntel([flow]);
    } else {
      flow = flowTool.toSimpleFormat(raw)
      flow.device = raw.mac
      enriched = await flowTool.enrichWithIntel([flow]);
    }
    return enriched[0]
  }


  async globalOn() {
    this.featureOn = true;
    const now = Date.now() / 1000;
    this.flowsType.map((type) => {
      this.setupFlowsQueue(type);
      this.setupStreams(type);
      this.dumpingMap[type] = false;
    })
    this.cornJob && this.cornJob.stop();
    this.cornJob = new CronJob("0 0 * * * *", async () => {
      // dump flow stream to redis hourly
      // losing data will be re-load by build when service restart
      const now = new Date() / 1000;
      const nowTickTs = now - now % this.step;
      await this.dumpStreamFlows(nowTickTs, "normal");
      await this.checkAndCleanMem();
    }, null, true)
    await rclient.setAsync(this.buildingKey, 1)
    await Promise.all([this.build(now), this.buildWanBlockCompressedFlows()])
    await rclient.setAsync(this.buildingKey, 0)
    log.info("Flows compression building done");
  }

  async globalOff() {
    this.featureOn = false;
    this.flowsType.map((type) => {
      const queueObj = this.queueMap[type];
      const streamObj = this.streamMap[type];
      queueObj && queueObj.destroy();
      streamObj && streamObj.destroyStreams && streamObj.destroyStreams();
    })
    this.queueMap = {};
    this.streamMap = {};
    this.dumpingMap = {};
    this.cornJob && this.cornJob.stop();
    this.cornJob = null;
  }

  async checkAndCleanMem() {
    const compressedFlowsKeys = await this.getCompreesedFlowsKey()
    let compressedMem = Number(await rclient.memoryAsync("usage", this.wanCompressedFlowsKey) || 0)
    let delFlag = false
    for (const key of compressedFlowsKeys) {
      if (delFlag) { // delete all earlier keys
        await rclient.unlinkAsync(key);
        continue;
      }
      const mem = Number(await rclient.memoryAsync("usage", key) || 0)
      compressedMem += mem
      if (compressedMem > this.maxMem) { // accumulate memory size from the latest
        delFlag = true;
        await rclient.unlinkAsync(key);
      }
    }
  }

  async apiRun() {
    extensionManager.onGet("compressedflowsBuildStatus", async (msg, data) => {
      const lastestTs = Number(await rclient.getAsync(this.lastestTsKey) || 0)
      const building = await rclient.getAsync(this.buildingKey) == "1"
      return { ts: lastestTs, building: building }
    })

    extensionManager.onGet("compressedflows", async (msg, data) => {
      const result = {}
      const now = new Date() / 1000
      result["compressedflows"] = await this.loadCompressedFlows(data)
      log.info(`Get flows cost ${(new Date() / 1000 - now).toFixed(2)}`)
      return result
    });
  }

  async loadCompressedFlows(options) {
    // options {begin,end}
    let { begin, end } = options
    log.info(`Load compressed flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    begin = begin - begin % this.step
    end = end - end % this.step + this.step
    await this.waitRealtimeDumpDone(); // emit dumpStreamFlows on firemain process and wait the dump done
    const compressedFlows = []
    for (let i = 0; i < (end - begin) / this.step; i++) {
      const endTs = begin + this.step * (i + 1)
      const str = await rclient.getAsync(this.getKey(endTs))
      str && compressedFlows.push(str)
    }
    const wanBlockCompressedFlows = await rclient.getAsync(this.wanCompressedFlowsKey);
    wanBlockCompressedFlows && compressedFlows.push(wanBlockCompressedFlows)
    return compressedFlows
  }

  async waitRealtimeDumpDone() {
    const messageId = uuid.v4();
    sem.emitEvent({
      type: "DumpStreamFlows",
      toProcess: 'FireMain',
      suppressEventLogging: false,
      messageId: messageId
    })
    return new Promise((resolve) => {
      const channelId = `DumpStreamFlows:Done-${messageId}`
      sem.on(channelId, (event) => {
        resolve()
      })
      setTimeout(() => {
        resolve();
      }, 30 * 1000);
    })
  }

  getKey(ts) {
    return `compressed:flows:${ts}`
  }

  async build(now) {
    if (this.normalBuilding) {
      return;
    }
    this.normalBuilding = true;
    try {
      const { begin, end } = await this.getBuildingWindow(now);
      if (begin == end) return
      log.info(`Going to compress flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
      for (let i = 0; i < (end - begin) / this.step; i++) {
        if (!this.featureOn) break;
        const beginTs = begin + this.step * i
        const endTs = begin + this.step * (i + 1)
        await this.loadFlows(beginTs, endTs)
      }
      await this.checkAndCleanMem()
      log.info(`Normal compressed flows build complted, cost ${(new Date() / 1000 - now).toFixed(2)}`)
    } catch (e) {
      log.error(`Compress flows error`, e)
    }
    this.normalBuilding = false;
  }

  async clean(ts) {
    const key = this.getKey(ts);
    await rclient.unlinkAsync(key);
  }

  async appendAndSave(ts, base64Str, type) {
    const tickTs = Math.ceil(ts / this.step) * this.step;
    const key = type == "wanBlock" ? this.wanCompressedFlowsKey : this.getKey(tickTs);
    await rclient.appendAsync(key, base64Str + SPLIT_STRING);
    await rclient.expireatAsync(key, tickTs + this.maxInterval);
    type != "wanBlock" && await rclient.setAsync(this.lastestTsKey, ts);
  }

  async getBuildingWindow(now) {
    const nowTickTs = Math.ceil(now / this.step) * this.step;
    let lastestTs = Number(await rclient.getAsync(this.lastestTsKey) || 0)
    if (nowTickTs - lastestTs > this.maxInterval) {
      lastestTs = nowTickTs - this.maxInterval
    }
    lastestTs = Math.floor(lastestTs / this.step) * this.step;
    return {
      begin: lastestTs,
      end: nowTickTs
    }
  }

  async buildWanBlockCompressedFlows() {
    if (this.wanBlockBuilding) {
      return;
    }
    this.wanBlockBuilding = true;
    log.info(`Going to compress wan block flows`)
    let completed = false
    let allFlows = []
    const now = Date.now() / 1000
    const options = {
      ts: now,
      audit: true,
      count: 2000,
      macs: sysManager.getLogicInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`)
    }
    await rclient.unlinkAsync(this.wanCompressedFlowsKey);
    while (!completed && this.featureOn) {
      try {
        const flows = await flowTool.prepareRecentFlows({}, JSON.parse(JSON.stringify(options))) || []
        if (flows.length < options.count) {
          completed = true
        } else {
          options.ts = flows[flows.length - 1].ts
        }
        allFlows = allFlows.concat(flows)
        if (allFlows.length >= this.maxCount) {
          // compress and dump flows to redis if it exceed count 
          // big array of allFlows might cause oom
          const ts = allFlows[allFlows.length - 1].ts;
          await this.appendAndSave(ts, await this.compress(allFlows), 'wanBlock')
          allFlows = [];
        }
      } catch (e) {
        log.error(`Load flows error`, e)
        completed = true
      }
    }
    if (allFlows.length > 0) {
      const ts = allFlows[allFlows.length - 1].ts;
      await this.appendAndSave(ts, await this.compress(allFlows), 'wanBlock')
    }
    log.info(`Wanblock compressed flows build complted, cost ${(new Date() / 1000 - now).toFixed(2)}`)
    this.wanBlockBuilding = false;
  }

  async loadFlows(begin, end) {
    log.info(`Going to load flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    // clean legacy data generated by api caller
    await this.clean(end)
    let completed = false
    const options = {
      begin: begin,
      end: end,
      audit: true,
      count: 2000,
      asc: true
    }
    let allFlows = []
    while (!completed && this.featureOn) {
      try {
        const flows = await flowTool.prepareRecentFlows({}, JSON.parse(JSON.stringify(options))) || []
        if (flows.length < options.count) {
          completed = true
        } else {
          options.begin = flows[flows.length - 1].ts
        }
        allFlows = allFlows.concat(flows.filter(f => {
          return f && f.ltype != 'audit' && f.device && !f.device.startsWith(Constants.NS_INTERFACE + ':')
        }))
        if (allFlows.length >= this.maxCount) {
          // compress and dump flows to redis if it exceed count 
          // big array of allFlows might cause oom
          const ts = allFlows[allFlows.length - 1].ts;
          await this.appendAndSave(ts, await this.compress(allFlows))
          allFlows = [];
        }
      } catch (e) {
        log.error(`Load flows error`, e)
        completed = true
      }
    }
    if (allFlows.length > 0) {
      const ts = allFlows[allFlows.length - 1].ts;
      await this.appendAndSave(ts, await this.compress(allFlows))
    }
  }
  async compress(flows) {
    const str = JSON.stringify(flows)
    const deflateBuffer = await deflateAsync(str)
    const base64Str = deflateBuffer.toString('base64')
    log.debug(`Compress ${flows.length} flows, raw: ${str.length} deflate: ${deflateBuffer.length} base64:${base64Str.length}`)
    return base64Str
  }

  async getCompreesedFlowsKey() {
    const compressedFlowsKeys = await rclient.scanResults(this.getKey("*"), 1000) || []
    return compressedFlowsKeys.filter(key => key != this.lastestTsKey).sort((a, b) => {
      const ts1 = a.split(":")[2];
      const ts2 = b.split(":")[2];
      return ts1 > ts2 ? -1 : 1
    })
  }

}


module.exports = FlowCompressionSensor;