/*    Copyright 2016-2025 Firewalla Inc.
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
const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;
const fc = require('../net2/config.js')
const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const TypeFlowTool = require('../flow/TypeFlowTool.js')
const appFlowTool = new TypeFlowTool('app')
const categoryFlowTool = new TypeFlowTool('category')

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const config = require('../net2/config.js').getConfig();
const excludedCategories = (config.category && config.category.exclude) || [];

const sem = require('../sensor/SensorEventManager.js').getInstance();

const platform = require('../platform/PlatformLoader.js').getPlatform();

// redis key to store the aggr result is redis zset aggrflow:<device_mac>:download:10m:<ts>
const IdentityManager = require('../net2/IdentityManager.js');
const Constants = require('../net2/Constants.js');
const sysManager = require('../net2/SysManager.js');
const Message = require('../net2/Message.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_TRAFFIC_CACHE = "LOCK_TRAFFIC_CACHE";
const LOCK_BLOCK_CACHE = "LOCK_BLOCK_CACHE";

const { compactTime } = require('../util/util')


class FlowAggregationSensor extends Sensor {
  constructor(config) {
    super(config);
    this.firstTime = true; // some work only need to be done once, use this flag to check
    this.retentionTimeMultipler = platform.getRetentionTimeMultiplier();
    this.retentionCountMultipler = platform.getRetentionCountMultiplier();
  }

  async scheduledJob() {
    log.info("Generating summarized flows info...")

    let trafficCache = null;
    let ipBlockCache = null;
    let dnsBlockCache = null;
    let ifBlockCache = null;
    let categoryFlowCache = null;
    let appFlowCache = null;
    // minimize critical section, retrieve global cache reference and set global cache to a new empty object
    await lock.acquire(LOCK_TRAFFIC_CACHE, async () => {
      trafficCache = this.trafficCache;
      this.trafficCache = {};
      categoryFlowCache = this.categoryFlowCache;
      this.categoryFlowCache = {};
      appFlowCache = this.appFlowCache;
      this.appFlowCache = {};
    }).catch((err) => {});
    await lock.acquire(LOCK_BLOCK_CACHE, async () => {
      ipBlockCache = this.ipBlockCache;
      dnsBlockCache = this.dnsBlockCache;
      ifBlockCache = this.ifBlockCache;
      this.ipBlockCache = {};
      this.dnsBlockCache = {};
      this.ifBlockCache = {};
    }).catch((err) => {});


    let ts = new Date() / 1000 - 90; // checkpoint time is set to 90 seconds ago
    await this.aggrAll(categoryFlowCache, appFlowCache).catch(err => log.error(err))

    // sum every hour
    await this.updateAllHourlySummedFlows(ts, trafficCache, ipBlockCache, dnsBlockCache, ifBlockCache).catch(err => log.error(err))
    /* todo
    const periods = platform.sumPeriods()
    for(const period  of periods){
       period => last 24  use 10 mins aggr
       period => daily    use houlry sum
       period => weekly   use daily sum
    }
    */

    // sum last 24 hours, hourly sum flow can be used to generate 24-hour sum flow
    await this.sumFlowRange(ts).catch(err => log.error(err))
    log.info("Summarized flow generation is complete");
  }

  run() {
    this.config.sumFlowExpireTime *= this.retentionTimeMultipler;
    this.config.sumFlowMaxFlow *= this.retentionCountMultipler;
    log.verbose("config.interval="+ this.config.interval);
    log.verbose("config.flowRange="+ this.config.flowRange);
    log.verbose("config.sumFlowExpireTime="+ this.config.sumFlowExpireTime);
    log.verbose("config.aggrFlowExpireTime="+ this.config.aggrFlowExpireTime); // aggrFlowExpireTime shoud be same as flowRange or bigger
    log.verbose("config.sumFlowMaxFlow="+ this.config.sumFlowMaxFlow);
    sem.once('IPTABLES_READY', async () => {
      // init host
      if (hostManager.getHostsFast().length == 0) {
        await hostManager.getHostsAsync();
      }

      process.nextTick(() => {
        this.scheduledJob();
      });

      setInterval(() => {
        this.scheduledJob();
      }, this.config.interval * 1000)

    });

    this.trafficCache = {};
    this.categoryFlowCache = {};
    this.appFlowCache = {};
    this.ipBlockCache = {};
    this.dnsBlockCache = {};
    this.ifBlockCache = {};

    // BroDetect -> DestIPFoundHook -> here
    sem.on(Message.MSG_FLOW_ENRICHED, async (event) => {
      if (event && event.flow) {
        await lock.acquire(LOCK_TRAFFIC_CACHE, async () => {
          this.processEnrichedFlow(event.flow);
        }).catch((err) => {
          log.error(`Failed to process enriched flow`, event.flow, err.message);
        });
      }
    });

    sem.on(Message.MSG_FLOW_ACL_AUDIT_BLOCKED, async (event) => {
      if (event && event.flow) {
        await lock.acquire(LOCK_BLOCK_CACHE, async () => {
          this.processBlockFlow(event.flow);
        }).catch((err) => {
          log.error(`Failed to process audit flow`, event.flow, err.message);
        });
      }
    });
  }

  processEnrichedFlow(flow) {
    const {fd, ip, _ts, intf, mac, ob, rb, dp, du, ts, local, dmac, dIntf, dstTags} = flow;
    const tags = [];
    const dTags = []
    // user and group are the same at this point
    for (const type of ['group', 'user']) {
      const config = Constants.TAG_TYPE_MAP[type];
      tags.push(...(flow[config.flowKey] || []));
      if (local && dstTags)
        dTags.push(...(dstTags[config.flowKey] || []))
    }
    if (!dp || !ip && !local || !mac || !_ts || (fd !== "in" && fd !== "out"))
      return;
    const tick = flowAggrTool.getIntervalTick(_ts, this.config.keySpan) + this.config.keySpan;
    const uidTickKeys = [];

    uidTickKeys.push(mac);
    if (intf)
      uidTickKeys.push(`intf:${intf}`);
    if (!_.isEmpty(tags))
      Array.prototype.push.apply(uidTickKeys, tags.map(tag => `tag:${tag}`));
    uidTickKeys.push(`global`);

    // adds :local to uid before @
    if (local)
      uidTickKeys.forEach((key, i) => uidTickKeys[i] = `${key}:local`)
    uidTickKeys.forEach((key, i) => uidTickKeys[i] = `${key}@${tick}`)

    const domain = flow.host || flow.intel && flow.intel.host;
    const key = `${mac}:${local ? dmac : ip}:${fd}:${dp}${domain ? `:${domain}` : ""}`;
    for (const uidTickKey of uidTickKeys) {
      if (!this.trafficCache[uidTickKey])
        this.trafficCache[uidTickKey] = {};

      let t = this.trafficCache[uidTickKey][key];
      if (!t) {
        t = {device: mac, upload: 0, download: 0, count: 0, fd};
        if (local) {
          t.dstMac = dmac
          if (uidTickKey.startsWith('intf:') && intf == dIntf) {
            t.intra = 1
          } else if (uidTickKey.startsWith('tag:')) {
            const tagID = uidTickKey.split(':')[1]
            if (dTags.includes(tagID)) {
              t.intra = 1
            }
          } else if (uidTickKey.startsWith('global')) {
            t.intra = 1
          }
        } else {
          t.destIP = ip
          if (domain)
            t.domain = domain;
        }
        // lagacy app only compatible with port number as string
        if (fd === "out")
          t.devicePort = [ String(dp) ];
        else
          t.port = [ String(dp) ];

        this.trafficCache[uidTickKey][key] = t;
      }
      t.upload += (fd === "out" ? rb : ob);
      t.download += (fd === "out" ? ob : rb);

      if (local) {
        t.count += flow.ct;
      }
    }

    const category = _.get(flow, ["intel", "category"]);
    if (category && !excludedCategories.includes(category)) {
      if (!this.categoryFlowCache[mac])
        this.categoryFlowCache[mac] = {};
      if (!this.categoryFlowCache[mac][category])
        this.categoryFlowCache[mac][category] = {download: 0, upload: 0, duration: 0, ts: _ts}
      const cache = this.categoryFlowCache[mac][category];
      cache.upload += (fd === "out" ? rb : ob);
      cache.download += (fd === "out" ? ob : rb);
      cache.duration = Math.max(cache.ts + cache.duration, ts + du) - Math.min(cache.ts, ts);
      cache.ts = Math.min(cache.ts, _ts);
    }

    const app = _.get(flow, ["intel", "app"]);
    if (app) {
      if (!this.appFlowCache[mac])
        this.appFlowCache[mac] = {};
      if (!this.appFlowCache[mac][app])
        this.appFlowCache[mac][app] = {download: 0, upload: 0, duration: 0, ts: _ts}
      const cache = this.appFlowCache[mac][app];
      cache.upload += (fd === "out" ? rb : ob);
      cache.download += (fd === "out" ? ob : rb);
      cache.duration = Math.max(cache.ts + cache.duration, ts + du) - Math.min(cache.ts, ts);
      cache.ts = Math.min(cache.ts, _ts);
    }
  }

  processBlockFlow(flow) {
    const {type, mac, _ts, intf, dp, fd, dir, dmac, dIntf, dstTags} = flow;
    if (!type || !mac || !_ts)
      return;
    const tags = [];
    const dTags = []
    for (const type of ['group', 'user']) {
      const config = Constants.TAG_TYPE_MAP[type];
      tags.push(...(flow[config.flowKey] || []));
      if (dir == 'L' && dstTags)
        dTags.push(...(dstTags[config.flowKey] || []))
    }
    const tick = flowAggrTool.getIntervalTick(_ts, this.config.keySpan) + this.config.keySpan;
    const uidTickKeys = [];
    uidTickKeys.push(mac);
    if (!mac.startsWith(Constants.NS_INTERFACE + ":")) {
      if (intf)
        uidTickKeys.push(`intf:${intf}`);
      if (!_.isEmpty(tags))
        Array.prototype.push.apply(uidTickKeys, tags.map(tag => `tag:${tag}`));
    }
    uidTickKeys.push(`global`); // empty string means global

    // adds :local to uid before @
    if (dir == 'L')
      uidTickKeys.forEach((key, i) => uidTickKeys[i] = `${key}:local`)
    uidTickKeys.forEach((key, i) => uidTickKeys[i] = `${key}@${tick}`)

    switch (flow.type) {
      case "ip": {
        if (mac.startsWith(Constants.NS_INTERFACE + ":")) {
          const key = `${mac}:${flow.sh}`;
          for (const uidTickKey of uidTickKeys) {
            if (!this.ifBlockCache[uidTickKey])
              this.ifBlockCache[uidTickKey] = {};
            let t = this.ifBlockCache[uidTickKey][key];
            if (!t) {
              t = {device: mac, destIP: flow.sh, fd: "out", count: 0};
              this.ifBlockCache[uidTickKey][key] = t;
            }
            t.count += flow.ct;
          }
        } else {
          if (!dp)
            return;
          const key = `${mac}:${dir=='L'?dmac:fd=="out"?flow.sh:flow.dh}:${fd}:${dp}`
          for (const uidTickKey of uidTickKeys) {
            if (!this.ipBlockCache[uidTickKey])
              this.ipBlockCache[uidTickKey] = {};
            let t = this.ipBlockCache[uidTickKey][key];
            if (!t) {
              t = {device: mac, fd, count: 0};
              if (dir == 'L') {
                if (flow.dmac)
                  t.dstMac = flow.dmac;
                if (uidTickKey.startsWith('intf:') && intf == dIntf) {
                  t.intra = 1
                } else if (uidTickKey.startsWith('tag:')) {
                  const tagID = uidTickKey.split(':')[1]
                  if (dTags.includes(tagID)) {
                    t.intra = 1
                  }
                } else if (uidTickKey.startsWith('global')) {
                  t.intra = 1
                }
              }
              if (fd === "out") {
                t.devicePort = [ String(dp) ];
                t.destIP = flow.sh;
              } else {
                t.port = [ String(dp) ];
                t.destIP = flow.dh;
              }
              this.ipBlockCache[uidTickKey][key] = t;
            }
            t.count += flow.ct;
          }
        }
        break;
      }
      case "dns": {
        const domain = flow.dn;
        const reason = flow.reason;
        if (!domain)
          return;
        const key = `${mac}:${domain}${reason ? `:${reason}` : ""}`;
        for (const uidTickKey of uidTickKeys) {
          if (!this.dnsBlockCache[uidTickKey])
            this.dnsBlockCache[uidTickKey] = {};
          let t = this.dnsBlockCache[uidTickKey][key];
          if (!t) {
            t = {device: mac, domain, count: 0};
            if (flow.dp)
              t.port = [ String(flow.dp) ];
            if (reason)
              t.reason = reason;
            this.dnsBlockCache[uidTickKey][key] = t;
          }
          t.count += flow.ct;
        }
        break;
      }
      default:
    }
  }

  async aggrAll(categoryFlowCache, appFlowCache) {
    // aggrflow is no longer needed after 1.978, sumflow is calculated incrementally from flow stream

    for (const mac in categoryFlowCache) {
      const traffic = categoryFlowCache[mac];
      await this.recordCategory(mac, traffic);
    }
    for (const mac in appFlowCache) {
      const traffic = appFlowCache[mac];
      await this.recordApp(mac, traffic);
    }
  }

  // this will be periodically called to update the hourly summed flows, it uses cache to incrementally update hourly sum flow
  async updateAllHourlySummedFlows(ts, trafficCache, ipBlockCache, dnsBlockCache, ifBlockCache) {
    log.debug('updateAllHourlySummedFlows started', ts)
    for (const key in trafficCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = trafficCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end, max_flow: this.config.sumFlowMaxFlow};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid, traffic, "upload", options);
      await flowAggrTool.incrSumFlow(uid, traffic, "download", options);
      await flowAggrTool.incrSumFlow(uid, traffic, null, options, 'in'); // 'local' is embeded in target
      await flowAggrTool.incrSumFlow(uid, traffic, null, options, 'out');
    }

    for (const key in ipBlockCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = ipBlockCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end, max_flow: this.config.sumAuditFlowMaxFlow};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid, traffic, "ipB", options, "in");
      await flowAggrTool.incrSumFlow(uid, traffic, "ipB", options, "out");
    }

    for (const key in dnsBlockCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = dnsBlockCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end, max_flow: this.config.sumAuditFlowMaxFlow};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid, traffic, "dnsB", options);
    }

    for (const key in ifBlockCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = ifBlockCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end, max_flow: this.config.sumAuditFlowMaxFlow};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid, traffic, "ifB", options, "out");
    }
    log.debug('updateAllHourlySummedFlows ended', ts)
  }

  async addFlowsForView(options) {
    const endString = compactTime(options.end)
    const beginString = compactTime(options.begin)

    if (options.intf) {
      log.debug(`Aggregating between ${beginString} and ${endString} for intf`, options.intf);
    } else if (options.tag) {
      log.debug(`Aggregating between ${beginString} and ${endString} for tag`, options.tag);
    } else if(options.mac) {
      log.debug(`Aggregating between ${beginString} and ${endString} for device ${options.mac}`);
    } else {
      log.debug(`Aggregating between ${beginString} and ${endString} globally`);
    }

    await flowAggrTool.addSumFlow("download", options);
    await flowAggrTool.addSumFlow("upload", options);
    if (platform.isAuditLogSupported() && fc.isFeatureOn(Constants.FEATURE_AUDIT_LOG)) {
      await flowAggrTool.addSumFlow("dnsB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow}));
      await flowAggrTool.addSumFlow("ipB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow}), "in");
      await flowAggrTool.addSumFlow("ipB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow}), "out");
    }
    if (fc.isFeatureOn(Constants.FEATURE_LOCAL_FLOW)) {
      await flowAggrTool.addSumFlow('local', options, 'download');
      await flowAggrTool.addSumFlow('local', options, 'upload');
      await flowAggrTool.addSumFlow('local', options, 'in');
      await flowAggrTool.addSumFlow('local', options, 'out');
    }
    if (platform.isAuditLogSupported() && fc.isFeatureOn(Constants.FEATURE_LOCAL_AUDIT_LOG)) {
      await flowAggrTool.addSumFlow("local:ipB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow}), "in");
      await flowAggrTool.addSumFlow("local:ipB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow}), "out");
    }
  }

  async sumViews(options) {
    log.debug('sumViews', JSON.stringify(options), '\n')
    // sum flows from bottom up, device/identity -> group -> network -> all devices, upper layer sum flow can be directly calculated from lower layer sum flow
    let allMacs = [];
    // aggregate devices
    const macs = hostManager.getActiveMACs();
    allMacs = allMacs.concat(macs);

    for (const mac of macs) {
      if(!mac) {
        continue;
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.mac = mac

      await this.addFlowsForView(optionsCopy)
    }

    // aggregate identities
    if (platform.isFireRouterManaged()) {
      const guids = IdentityManager.getAllIdentitiesGUID();
      allMacs = allMacs.concat(guids);

      for (const guid of guids) {
        if (!guid)
          continue;

        const optionsCopy = JSON.parse(JSON.stringify(options));
        optionsCopy.mac = guid;

        await this.addFlowsForView(optionsCopy);
      }
    }

    // aggregate wan input block audit logs
    if (platform.isAuditLogSupported()) {
      // for Firewalla interface as device, use ifB as its namespace
      const allIfs = [];
      for (const selfMac of sysManager.getLogicInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`)) {
        const optionsCopy = JSON.parse(JSON.stringify(options));
        optionsCopy.mac = selfMac
        optionsCopy.max_flow = this.config.sumAuditFlowMaxFlow || 400;
        // other types are not applicable for wan input block, e.g., dns, category, upload, download
        await flowAggrTool.addSumFlow('ifB', optionsCopy, "out"); // no outbound block in practice
        allIfs.push(selfMac);
      }
      await flowAggrTool.addSumFlow("ifB", Object.assign({}, options, {macs: allIfs, max_flow: this.config.sumAuditFlowMaxFlow || 400}), "out")
    }

    // aggregate tags
    const tags = await hostManager.getActiveTags(['group', 'user']);

    for (const tag of tags) {
      if(!tag || _.isEmpty(tag.macs)) {
        continue;
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.tag = tag.tag;
      optionsCopy.macs = tag.macs;

      await this.addFlowsForView(optionsCopy)
    }

    // aggregate intf
    const intfs = hostManager.getActiveIntfs();

    for (const intf of intfs) {
      if(!intf || _.isEmpty(intf.macs)) {
        continue;
      }

      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.intf = intf.intf;
      optionsCopy.macs = intf.macs;

      await this.addFlowsForView(optionsCopy)
    }

    // aggregate all devices
    await this.addFlowsForView(Object.assign({}, options, {macs: allMacs}))
  }

  async sumFlowRange(ts) {
    const now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      throw new Error("sum too soon")
    }

    const end = flowAggrTool.getIntervalTick(ts, this.config.keySpan);
    const begin = end - this.config.flowRange;

    const options = {
      begin: begin,
      end: end,
      interval: this.config.keySpan,
      summedInterval: 3600,
      // if working properly, flowaggregation sensor run every 10 mins
      // last 24 hours sum flows will generate every 10 mins
      // make sure expireTime greater than 10 mins and expire key to reduce memonry usage, differnet with hourly sum flows should retention
      expireTime: 24 * 60,
      setLastSumFlow: true,
      max_flow: this.config.sumFlowMaxFlow
    }

    await this.sumViews(options)
  }

  selectVeryRecentActivity(recentActivity, flows) {
    if(flows.length > 0) {
      // assume it's ordered
      let lastOne = flows[flows.length - 1]
      if(recentActivity == null || recentActivity.ts < lastOne.ts) {
        return lastOne
      }
    }

    return recentActivity
  }

  async recordApp(mac, traffic) {
    for(let app in traffic) {
      let object = traffic[app]
      await appFlowTool.addTypeFlowObject(mac, app, object)
    }
  }

  async recordCategory(mac, traffic) {
    for(let category in traffic) {

      // FIXME
      // ignore technology and search-portal for better performanced
      if(excludedCategories.includes(category)) {
        continue;
      }
      let object = traffic[category]
      await categoryFlowTool.addTypeFlowObject(mac, category, object)
    }
  }

  async getFlow(dimension, type, options) {
    let flows = []

    let macs = []

    if (options.intf || options.tag) {
      macs = options.macs;
    } else if (options.mac) {
      macs = [options.mac]
    } else {
      macs = hostManager.getActiveMACs()
    }


    const typeFlowTool = new TypeFlowTool(dimension)
    const getTypeFlow = typeFlowTool.getTypeFlow.bind(typeFlowTool)

    for (const mac of macs) {
      let typeFlows = await getTypeFlow(mac, type, options)
      typeFlows = typeFlows.filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
      typeFlows.forEach((f) => {
        f.device = mac
      })

      flows.push.apply(flows, typeFlows)
    }

    flows.sort((a, b) => {
      return b.ts - a.ts
    })

    return flows
  }
}

module.exports = FlowAggregationSensor;
