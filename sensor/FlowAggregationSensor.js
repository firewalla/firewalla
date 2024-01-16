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
const _ = require('lodash');
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const flowTool = require('../net2/FlowTool');
const auditTool = require('../net2/AuditTool');
const FlowAggrTool = require('../net2/FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const ActivityAggrTool = require('../flow/ActivityAggrTool');

const TypeFlowTool = require('../flow/TypeFlowTool.js')
const appFlowTool = new TypeFlowTool('app')
const categoryFlowTool = new TypeFlowTool('category')

const HostTool = require('../net2/HostTool')
const hostTool = new HostTool();

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const flowUtil = require('../net2/FlowUtil')

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

const asyncNative = require('../util/asyncNative.js');
const { compactTime } = require('../util/util')

const LRU = require('lru-cache');

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
    await this.aggrAll(trafficCache, ipBlockCache, dnsBlockCache, ifBlockCache, categoryFlowCache, appFlowCache).catch(err => log.error(err))

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
    this.hourlySumFlowKeysToTrim = new Map();

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
    const {fd, ip, _ts, intf, mac, ob, rb, dp, du, ts} = flow;
    const tags = [];
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      tags.push(...(flow[config.flowKey] || []));
    }
    if (!dp || !ip || !mac || !_ts || (fd !== "in" && fd !== "out"))
      return;
    const tick = flowAggrTool.getIntervalTick(_ts, this.config.keySpan) + this.config.keySpan;
    const uidTickKeys = [];
    uidTickKeys.push(`${mac}@${tick}`);
    if (intf)
      uidTickKeys.push(`intf:${intf}@${tick}`);
    if (!_.isEmpty(tags))
      Array.prototype.push.apply(uidTickKeys, tags.map(tag => `tag:${tag}@${tick}`));
    uidTickKeys.push(`global@${tick}`);
    
    const domain = flow.host || flow.intel && flow.intel.host;
    const key = `${ip}:${dp}${domain ? `:${domain}` : ""}`;
    for (const uidTickKey of uidTickKeys) {
      if (!this.trafficCache[uidTickKey])
        this.trafficCache[uidTickKey] = {};
      
      let t = this.trafficCache[uidTickKey][key];
      if (!t) {
        t = {device: mac, upload: 0, download: 0, destIP: ip, fd};
        if (domain)
          t.domain = domain;
        // lagacy app only compatible with port number as string
        if (fd === "out")
          t.devicePort = [ String(dp) ];
        else
          t.port = [ String(dp) ];
  
        this.trafficCache[uidTickKey][key] = t;
      }
      t.upload += (fd === "out" ? rb : ob);
      t.download += (fd === "out" ? ob : rb);
    }

    const category = _.get(flow, ["intel", "category"]);
    if (category && !excludedCategories.includes(category)) {
      if (!this.categoryFlowCache[mac])
        this.categoryFlowCache[mac] = {};
      if (!this.categoryFlowCache[mac][category])
        this.categoryFlowCache[mac][category] = {download: 0, upload: 0, duration: 0, ts}
      const cache = this.categoryFlowCache[mac][category];
      cache.upload += (fd === "out" ? rb : ob);
      cache.download += (fd === "out" ? ob : rb);
      cache.duration = Math.max(cache.ts + cache.duration, ts + du) - Math.min(cache.ts, ts);
      cache.ts = Math.min(cache.ts, ts);
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
    const {type, mac, _ts, intf, dp, fd} = flow;
    if (!type || !mac || !_ts)
      return;
    const tags = [];
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      tags.push(...(flow[config.flowKey] || []));
    }
    const tick = flowAggrTool.getIntervalTick(_ts, this.config.keySpan) + this.config.keySpan;
    const uidTickKeys = [];
    uidTickKeys.push(`${mac}@${tick}`);
    if (!mac.startsWith(Constants.NS_INTERFACE + ":")) {
      if (intf)
        uidTickKeys.push(`intf:${intf}@${tick}`);
      if (!_.isEmpty(tags))
        Array.prototype.push.apply(uidTickKeys, tags.map(tag => `tag:${tag}@${tick}`));
    }
    uidTickKeys.push(`global@${tick}`); // empty string means global
    switch (flow.type) {
      case "ip": {
        if (mac.startsWith(Constants.NS_INTERFACE + ":")) {
          const key = flow.sh;
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
          const key = (fd === "out" ? `${flow.sh}:${dp}:inbound` : `${flow.dh}:${dp}:outbound`);
          for (const uidTickKey of uidTickKeys) {
            if (!this.ipBlockCache[uidTickKey])
              this.ipBlockCache[uidTickKey] = {};
            let t = this.ipBlockCache[uidTickKey][key];
            if (!t) {
              t = {device: mac, fd, count: 0};
              if (flow.dmac)
                t.dstMac = flow.dmac;
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
        const key = `${domain}${reason ? `:${reason}` : ""}`;
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

  async trafficGroupByX(flows, x) {
    let traffic = {};

    for (const flow of flows) {
      let destIP = flowTool.getDestIP(flow);
      const domains = Object.keys(flow.af) || [];
      let intel = await intelTool.getIntel(destIP, domains);

      // skip if no app or category intel
      if(!(intel && (intel.app || intel.category)))
        continue;

      let appInfos = [];

      if(intel[x]) {
        appInfos.push(intel[x])
      }

      appInfos.forEach((app) => {

        // no need to group traffic for these two types in particular, FIXME
        if (excludedCategories.includes(app)) {
          return;
        }

        let t = traffic[app];

        if (! (app in traffic) ) {
          traffic[app] = {
            duration: Math.round(flow.du * 100) / 100,
            ts: flow.ts,
            ets: flow.ets || Date.now() / 1000,
            download: flowTool.getDownloadTraffic(flow),
            upload: flowTool.getUploadTraffic(flow)
          };
        } else {
          // FIXME: Should have more accurate calculation here
          // TBD: this duration calculation also needs to be discussed as the one in BroDetect.processConnData
          // However we use total time from the beginning of first flow to the end of last flow here, since this data is supposed to be shown on app and more user friendly.
          // t.duration += flow.du;
          t.duration = Math.round((Math.max(flow.ts + flow.du, t.ts + t.duration) - Math.min(flow.ts, t.ts)) * 100) / 100;
          // ts stands for the earliest start timestamp of this kind of activity
          t.ts = Math.min(flow.ts, t.ts);
          t.ets = Math.max(flow.ets, t.ets);
          t.download += flowTool.getDownloadTraffic(flow) || 0;
          t.upload += flowTool.getUploadTraffic(flow) || 0;
        }
      })
    }

    return traffic;
  }

  trafficGroupByApp(flows) {
    return this.trafficGroupByX(flows, "app")
  }

  trafficGroupByCategory(flows) {
    return this.trafficGroupByX(flows, "category")
  }

  // flows => { ip1 => 100KB, ip2 => 2MB }
  trafficGroupByDestIP(flows) {

    const traffic = {};

    flows.forEach((flow) => {
      const domain = _.isArray(flow.appHosts) && !_.isEmpty(flow.appHosts) ? flow.appHosts[0] : null;
      // add domain into group key if available
      const descriptor = `${flow.ip}:${flow.fd  == 'out' ? flow.devicePort : flow.port}${domain ? `:${domain}` : ""}`

      let t = traffic[descriptor];

      if (!t) {
        t = { upload: 0, download: 0, destIP: flow.ip, fd: flow.fd };
        if (domain)
          t.domain = domain;
        // lagacy app only compatible with port number as string
        if (flow.fd == 'out') {
          // TBD: unwrap this array to save memory
          if (flow.hasOwnProperty("devicePort")) t.devicePort = [ String(flow.devicePort) ]
          else log.warn('Data corrupted, no devicePort', flow)
        } else {
          if (flow.port) t.port = [ String(flow.port) ]
          else log.warn('Data corrupted, no port', flow)
        }

        traffic[descriptor] = t;
      }

      t.upload += flow.upload;
      t.download += flow.download;
    });

    return traffic;
  }

  auditLogsGroupByDestIP(logs) {
    const result = { dns: {}, ip: {} };

    logs.forEach(l => {
      const type = l.type == 'tls' ? 'ip' : l.type

      let descriptor = l.type == 'dns' ? `${l.domain}${l.reason ? `:${l.reason}` : ""}` : `${l.ip}:${l.fd  == 'out' ? l.devicePort : l.port}`;
      if (l.type == 'ip' && l.fd == 'out' && l.device && l.device.startsWith(Constants.NS_INTERFACE + ':')) {
        // only use remote ip to aggregate for wan input block flows
        descriptor = l.ip
      }
      let t = result[type][descriptor];

      if (!t) {
        t = { count: 0 };

        if (l.dstMac) t.dstMac = l.dstMac

        // lagacy app only compatible with port number as string
        if (l.fd == 'out') {
          if (l.hasOwnProperty("devicePort") && l.device && !l.device.startsWith(Constants.NS_INTERFACE + ':')) t.devicePort = [ String(l.devicePort) ]
          // inbound blocks targeting interface doesn't have port
          else if (!l.device.startsWith(Constants.NS_INTERFACE+':')) log.warn('Data corrupted, no devicePort', l)
        } else { // also covers dns here
          if (l.port) t.port = [ String(l.port) ]
          else log.warn('Data corrupted, no port', l)
        }

        if (l.type == 'dns') {
          t.domain = l.domain
          if (l.reason)
            t.reason = l.reason;
        } else {
          t.destIP = l.ip
          t.fd = l.fd
        }

        result[type][descriptor] = t;
      }

      t.count += l.count;
    });

    return result;
  }

  async aggrAll(trafficCache, ipBlockCache, dnsBlockCache, ifBlockCache, categoryFlowCache, appFlowCache) {
    for (const key in trafficCache) {
      const [uid, aggrTs] = key.split("@");
      if (!uid.startsWith("intf:") && !uid.startsWith("tag:") && uid !== "global") {
        const traffic = trafficCache[key];
        await flowAggrTool.addFlows(uid, "upload", this.config.keySpan, aggrTs, traffic, this.config.aggrFlowExpireTime);
        await flowAggrTool.addFlows(uid, "download", this.config.keySpan, aggrTs, traffic, this.config.aggrFlowExpireTime);
      }
    }

    for (const key in ipBlockCache) {
      const [uid, aggrTs] = key.split("@");
      if (!uid.startsWith("intf:") && !uid.startsWith("tag:") && uid !== "global") {
        const traffic = ipBlockCache[key];
        await flowAggrTool.addFlows(uid, "ipB", this.config.keySpan, aggrTs, traffic, this.config.aggrFlowExpireTime, "in");
        await flowAggrTool.addFlows(uid, "ipB", this.config.keySpan, aggrTs, traffic, this.config.aggrFlowExpireTime, "out");
      }
    }

    for (const key in dnsBlockCache) {
      const [uid, aggrTs] = key.split("@");
      if (!uid.startsWith("intf:") && !uid.startsWith("tag:") && uid !== "global") {
        const traffic = dnsBlockCache[key];
        await flowAggrTool.addFlows(uid, "dnsB", this.config.keySpan, aggrTs, traffic, this.config.aggrFlowExpireTime);
      }
    }

    for (const key in ifBlockCache) {
      const [uid, aggrTs] = key.split("@");
      if (uid.startsWith(Constants.NS_INTERFACE + ":")) {
        const traffic = dnsBlockCache[key];
        await flowAggrTool.addFlows(uid, "ifB", this.config.keySpan, aggrTs, traffic, this.config.aggrFlowExpireTime, "out");
      }
    }

    for (const mac in categoryFlowCache) {
      const traffic = categoryFlowCache[mac];
      await this.recordCategory(mac, traffic);
    }
    for (const mac in appFlowCache) {
      const traffic = appFlowCache[mac];
      await this.recordApp(mac, traffic);
    }
    /*
    let now = new Date() / 1000;

    if(now < ts + 60) {
      // TODO: could have some enhancement here!
      // if the diff between ts and now is less than 60 seconds, return error
      // this is to ensure the flows are already processed and stored in redis before aggregation
      throw new Error("aggregation too soon");
    }

    const end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    const begin = end - this.config.interval;

    const macs = (await flowAggrTool.getDevicesWithFlowTs(begin)).filter(mac => !sysManager.isMyMac(mac)); // this includes MAC address and identity GUID
    macs.push(... sysManager.getLogicInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`))
    await asyncNative.eachLimit(macs, 20, async mac => {
      await this.aggr(mac, ts).catch(err => log.error('Error aggregating flows', mac, ts, err))
      await this.aggrActivity(mac, ts).catch(err => log.error('Error aggregating activity', mac, ts, err))
    })
    */
  }

  // this will be periodically called to update the hourly summed flows, it uses cache to incrementally update hourly sum flow
  async updateAllHourlySummedFlows(ts, trafficCache, ipBlockCache, dnsBlockCache, ifBlockCache) {
    for (const key in trafficCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = trafficCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid === "global" ? null : uid, traffic, "upload", options);
      await flowAggrTool.incrSumFlow(uid === "global" ? null : uid, traffic, "download", options);
      if (!this.hourlySumFlowKeysToTrim.has(end))
        this.hourlySumFlowKeysToTrim.set(end, new Map());
      this.hourlySumFlowKeysToTrim.get(end).set(flowAggrTool.getSumFlowKey(uid === "global" ? null : uid, "upload", begin, end), this.config.sumFlowMaxFlow);
      this.hourlySumFlowKeysToTrim.get(end).set(flowAggrTool.getSumFlowKey(uid === "global" ? null : uid, "download", begin, end), this.config.sumFlowMaxFlow);
    }

    for (const key in ipBlockCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = ipBlockCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid === "global" ? null : uid, traffic, "ipB", options, "in");
      await flowAggrTool.incrSumFlow(uid === "global" ? null : uid, traffic, "ipB", options, "out");
      if (!this.hourlySumFlowKeysToTrim.has(end))
        this.hourlySumFlowKeysToTrim.set(end, new Map());
      this.hourlySumFlowKeysToTrim.get(end).set(flowAggrTool.getSumFlowKey(uid === "global" ? null : uid, "ipB", begin, end, "in"), this.config.sumAuditFlowMaxFlow);
      this.hourlySumFlowKeysToTrim.get(end).set(flowAggrTool.getSumFlowKey(uid === "global" ? null : uid, "ipB", begin, end, "out"), this.config.sumAuditFlowMaxFlow);
    }

    for (const key in dnsBlockCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = dnsBlockCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid === "global" ? null : uid, traffic, "dnsB", options);
      if (!this.hourlySumFlowKeysToTrim.has(end))
        this.hourlySumFlowKeysToTrim.set(end, new Map());
      this.hourlySumFlowKeysToTrim.get(end).set(flowAggrTool.getSumFlowKey(uid === "global" ? null : uid, "dnsB", begin, end), this.config.sumAuditFlowMaxFlow);
    }

    for (const key in ifBlockCache) {
      const [uid, aggrTs] = key.split("@");
      const traffic = ifBlockCache[key];
      const end = Math.ceil(aggrTs / 3600) * 3600;
      const begin = end - 3600;
      const options = {begin, end};
      options.expireTime = this.config.sumFlowExpireTime;
      await flowAggrTool.incrSumFlow(uid === "global" ? null : uid, traffic, "ifB", options, "out");
      if (!this.hourlySumFlowKeysToTrim.has(end))
        this.hourlySumFlowKeysToTrim.set(end, new Map());
      this.hourlySumFlowKeysToTrim.get(end).set(flowAggrTool.getSumFlowKey(uid === "global" ? null : uid, "ifB", begin, end, "out"), this.config.sumAuditFlowMaxFlow);
    }

    for (const end of this.hourlySumFlowKeysToTrim.keys()) {
      if (ts - end > 900) {
        const keyCountMap = this.hourlySumFlowKeysToTrim.get(end);
        for (const key of keyCountMap.keys()) {
          await flowAggrTool.trimSumFlow(key, {max_flow: keyCountMap.get(key)});
        }
        this.hourlySumFlowKeysToTrim.delete(end);
      }
    }

    /*
    const lastHourTick = Math.floor(ts / 3600) * 3600;
    // last hour and this hour
    for (let i = -1; i < 1; i++) {
      let ts = lastHourTick - i * 3600;
      await this.hourlySummedFlows(ts, {
        skipIfExists: false
      });
    }
    */
  }

  // sum all traffic together, across devices
  async hourlySummedFlows(ts, opts) {
    // ts is the end timestamp of the hour
    ts = Math.floor(ts / 3600) * 3600
    const end = ts;
    const begin = end - 3600;
    const skipIfExists = opts && opts.skipIfExists;

    const endString = compactTime(end)
    const beginString = compactTime(begin)
    log.verbose(`Aggregating hourly flows for ${beginString} - ${endString}, skipIfExists flag: ${skipIfExists}`)

    const options = {
      begin: begin,
      end: end,
      interval: this.config.keySpan,
      expireTime: this.config.sumFlowExpireTime, // hourly sumflow retention time should be blue/red 24hours, navy/gold 72hours
      skipIfExists: skipIfExists,
      max_flow: 200
    }

    await this.sumViews(options)
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
    if (platform.isAuditLogSupported()) {
      await flowAggrTool.addSumFlow("dnsB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow || 400}));
      await flowAggrTool.addSumFlow("ipB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow || 400}), "in");
      await flowAggrTool.addSumFlow("ipB", Object.assign({}, options, {max_flow: this.config.sumAuditFlowMaxFlow || 400}), "out");
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
    const tags = await hostManager.getActiveTags();

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

  async _flowHasActivity(flow, cache) {
    cache = cache || {}

    let destIP = flowTool.getDestIP(flow);
    const domains = Object.keys(flow.af) || [];
    if (!_.isEmpty(domains)) { // if 'domains' is not empty, inteldns will be used in getIntel, so no need to check destIP
      if (cache) {
        let someTrue = false;
        let allFalse = true;
        for (const domain of domains) {
          if (!cache.hasOwnProperty(domain))
            allFalse = false;
          else {
            if (cache[domain] === 1) {
              someTrue = true;
              allFalse = false;
              break;
            }
          }
        }
        if (allFalse)
          return false;
        if (someTrue)
          return true;
      }
    } else {
      if (cache && cache[destIP] === 1) {
        return true;
      }
    }

    let intel = await intelTool.getIntel(destIP, domains);
    if(intel == null ||
      (!intel.app && !intel.category) ||
      intel.category && excludedCategories.includes(intel.category)) {
      if (!_.isEmpty(domains)) {
        if (intel.host) // just in case, intel.host should always exist here if 'domains' is not empty
          cache[intel.host] = 0;
      } else
        cache[destIP] = 0;
      return false;
    } else {
      if (!_.isEmpty(domains)) {
        if (intel.host)
          cache[intel.host] = 1;
      } else
        cache[destIP] = 1;
      return true;
    }
  }

  async aggrActivity(macAddress, ts) {
    if (sysManager.isMyMac(macAddress)) return

    let end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    let begin = end - this.config.interval;

    const endString = compactTime(end)
    const beginString = compactTime(begin)

    log.verbose(`Aggregating activities for ${macAddress} between ${beginString} and ${endString}`);

    let flows = [];

    let recentFlow = null;

    let cache = {};

    let outgoingFlows = await flowTool.queryFlows(macAddress, "in", begin, end); // in => outgoing
    const outgoingFlowsHavingIntels = [];
    for(const flow of outgoingFlows) {
      const flag = await this._flowHasActivity(flow, cache);
      if(flag) {
       flows.push(flow);
       outgoingFlowsHavingIntels.push(flow);
      }
    }

    recentFlow = this.selectVeryRecentActivity(recentFlow, outgoingFlowsHavingIntels)

    const incomingFlowsHavingIntels = [];
    let incomingFlows = await flowTool.queryFlows(macAddress, "out", begin, end); // out => incoming
    for(const flow of incomingFlows) {
      const flag = await this._flowHasActivity(flow, cache);
      if(flag) {
        flows.push(flow);
        incomingFlowsHavingIntels.push(flow);
      }
    }

    recentFlow = this.selectVeryRecentActivity(recentFlow, incomingFlowsHavingIntels)

    // now flows array should only contain flows having intels

    for (const dimension of ['app', 'category']) {
      const activityTraffic = await this.trafficGroupByX(flows, dimension);
      const activityAggrTool = new ActivityAggrTool(dimension)
      await activityAggrTool.addActivityFlows(macAddress, this.config.keySpan, end, activityTraffic, this.config.aggrFlowExpireTime);

      // record detail app/category flows for upload/download/ts/duration
      if (dimension == 'app')
        await this.recordApp(macAddress, activityTraffic);
      else
        await this.recordCategory(macAddress, activityTraffic);
    }

    if(recentFlow) {
      const destIP = flowTool.getDestIP(recentFlow);
      const intel = await intelTool.getIntel(destIP, recentFlow.af && Object.keys(recentFlow.af) || []);
      const recentActivity = {
        ts: recentFlow.ts,
        app: intel && intel.app,
        category: intel && intel.category
      };
      await hostTool.updateRecentActivity(macAddress, recentActivity);
    }
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

  async aggr(macAddress, ts) {
    const end = flowAggrTool.getIntervalTick(ts, this.config.interval);
    const begin = end - this.config.interval;

    const endString = compactTime(end)
    const beginString = compactTime(begin)

    log.verbose(`Aggregating flow for ${macAddress} between ${beginString} and ${endString}`)

    // NOTE: BroDetect.flowstash rotates every 15min, and the actual merge of redis flow happens after another 15min
    // so the aggregation here always gets unmerged flows, which could be massive, but also more timely accurate
    // if the actual flow count exceeds count provided here, aggregated result will likely be smaller than the real number
    if (!macAddress.startsWith(Constants.NS_INTERFACE+':')) {
      // in => outgoing, out => incoming
      const outgoingFlows = await flowTool.getDeviceLogs({ mac: macAddress, direction: "in", begin, end, count: 1000, enrich: false});
      const incomingFlows = await flowTool.getDeviceLogs({ mac: macAddress, direction: "out", begin, end, count: 1000, enrich: false});
      // do not use Array.prototype.push.apply since it may cause maximum call stack size exceeded
      const flows = outgoingFlows.concat(incomingFlows)
      if (flows.length) {
        const traffic = this.trafficGroupByDestIP(flows);
        await flowAggrTool.addFlows(macAddress, "upload", this.config.keySpan, end, traffic, this.config.aggrFlowExpireTime);
        await flowAggrTool.addFlows(macAddress, "download", this.config.keySpan, end, traffic, this.config.aggrFlowExpireTime);
      }
    }

    if (platform.isAuditLogSupported()) {
      const auditLogs = await auditTool.getDeviceLogs({ mac: macAddress, begin, end, block: true, count: 2000, enrich: false});
      if (auditLogs.length) {
        const groupedLogs = this.auditLogsGroupByDestIP(auditLogs);
        if (!macAddress.startsWith(Constants.NS_INTERFACE+':')) {
          await flowAggrTool.addFlows(macAddress, "dnsB", this.config.keySpan, end, groupedLogs.dns, this.config.aggrFlowExpireTime);
          await flowAggrTool.addFlows(macAddress, "ipB", this.config.keySpan, end, groupedLogs.ip, this.config.aggrFlowExpireTime, "in");
          await flowAggrTool.addFlows(macAddress, "ipB", this.config.keySpan, end, groupedLogs.ip, this.config.aggrFlowExpireTime, "out");
        } else {
          // use dedicated namespace for interface input block flow aggregation
          await flowAggrTool.addFlows(macAddress, "ifB", this.config.keySpan, end, groupedLogs.ip, this.config.aggrFlowExpireTime, "out");
        }
      }
    }
    // dns aggrflow, disable for now to reduce memory cost
    // const dnsLogs = await auditTool.getDeviceLogs({ mac: macAddress, begin, end, block: false});
    // const groupedDnsLogs = this.auditLogsGroupByDestIP(dnsLogs);
    // await flowAggrTool.addFlows(macAddress, "dns", this.config.keySpan, end, groupedDnsLogs.dns, this.config.aggrFlowExpireTime);
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

  async summarizeActivity(options, dimension, types) {
    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    const activityAggrTool = new ActivityAggrTool(dimension)

    try {
      if(options.skipIfExists) {
        let exists = await activityAggrTool.keyExists(begin, end, options)
        if(exists) {
          return
        }
      }

      let allFlows = {}

      for (const type of types) {
        let flows = await this.getFlow(dimension, type, options)
        if(flows.length > 0) {
          allFlows[type] = flows
        }
      }

      // allFlows now contains all raw app activities during this range

      let hashCache = {}

      if(Object.keys(allFlows).length > 0) {
        await activityAggrTool.setActivity(begin, end, allFlows, options)

        // change after store
        flowUtil.hashIntelFlows(allFlows, hashCache)
//        await bone.flowgraphAsync('summarizeApp', allFlows)
//        let unhashedData = flowUtil.unhashIntelFlows(data, hashCache)
      } else {
        await activityAggrTool.setActivity(begin, end, {}, options) // if no data, set an empty {}
      }
    } catch(err) {
      log.error(`Failed to summarize ${dimension} activity: `, err);
    }
  }
}

module.exports = FlowAggregationSensor;
