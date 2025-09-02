/*    Copyright 2016-2024 Firewalla Inc.
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
const log = require('./logger.js')(__filename);

const FlowAggrTool = require('./FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const ActivityAggrTool = require('../flow/ActivityAggrTool')

const TypeFlowTool = require('../flow/TypeFlowTool.js')

const flowTool = require('./FlowTool.js');

const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const identityManager = require('../net2/IdentityManager.js');
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));
const sysManager = require('./SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('./Message.js');

const TimeUsageTool = require('../flow/TimeUsageTool.js');

let instance = null;

function toInt(n){ return Math.floor(Number(n)); }


class NetBotTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  prepareTopDownloadFlows(json, options) {
    return this.prepareTopFlows(json, "download", null, options);
  }

  prepareTopUploadFlows(json, options) {
    return this.prepareTopFlows(json, "upload", null, options);
  }

  async prepareDetailedFlowsFromCache(json, dimension, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    if (!['app', 'category'].includes(dimension)) throw new Error(`Dimension not supported, ${dimension}`)

    const begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    const end = options.end || (begin + 3600);

    const endString = new Date(end * 1000).toLocaleTimeString();
    const beginString = new Date(begin * 1000).toLocaleTimeString();

    log.verbose(`[Cache] Getting ${dimension} detail flows between ${beginString} and ${endString}`, options)

    const key = dimension + 'Details'

    const activityAggrTool = new ActivityAggrTool(dimension)

    let flows = null
    if (options.queryall && options.mac) {
      // need to support queryall too
      let lastAppActivityKey = await activityAggrTool.getLastActivity(options.mac)
      if (lastAppActivityKey) {
        flows = await activityAggrTool.getActivityByKey(lastAppActivityKey)
      }
    } else {
      flows = await activityAggrTool.getActivity(begin, end, options)
    }
    if (_.isObject(flows)) {
      for (const type of Object.keys(flows))
        this._dedupActivityDuration(flows[type]);
    }
    if (flows) {
      json.flows[key] = flows
    }
    log.debug(`[Cache] Finished getting ${dimension} detail flows between ${beginString} and ${endString}`)
    return flows
  }

  async prepareDetailedFlows(json, dimension, options) {
    options = options || {}

    if (!("flows" in json)) {
      json.flows = {};
    }

    if (!['app', 'category'].includes(dimension)) throw new Error(`Dimension not supported, ${dimension}`)

    const begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    const end = options.end || (begin + 3600);

    const endString = new Date(end * 1000).toLocaleTimeString();
    const beginString = new Date(begin * 1000).toLocaleTimeString();

    log.verbose(`Getting ${dimension} detail flows between ${beginString} and ${endString}`);

    const key = dimension + 'Details'

    json.flows[key] = {}

    // getting all related mac
    let allMacs = options.macs || [];
    if (_.isEmpty(allMacs)) {
      if (options.intf) {
        allMacs = hostManager.getIntfMacs(options.intf);
        log.info(`prepareDetailedFlows ${dimension} intf: ${options.intf}, ${allMacs}`);
      } else if (options.tag) {
        allMacs = await hostManager.getTagMacs(options.tag);
        log.info(`prepareDetailedFlows ${dimension} tag: ${options.tag}, ${allMacs}`);
      } else if (options.mac) {
        allMacs = [options.mac]
      } else {
        allMacs = hostManager.getActiveMACs().concat(identityManager.getAllIdentitiesGUID())
      }
    }


    // getting all app involved
    // apps are return from cloud intel, there's no list on box we could iterate here

    const typeFlowTool = new TypeFlowTool(dimension)
    const typeSet = await typeFlowTool.getTypes('*')

    let allFlows = {}
    for (const type of typeSet) {
      allFlows[type] = []

      for (const mac of allMacs) {
        const typeFlows = await typeFlowTool.getTypeFlow(mac, type, options)
        this._dedupActivityDuration(typeFlows);
        allFlows[type].push(... typeFlows)
      }

      allFlows[type] = allFlows[type]
        .filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
        .sort((a, b) => {
          return b.ts - a.ts;
        });
      if (!allFlows[type].length) delete allFlows[type]
    }
    json.flows[key] = allFlows
    return allFlows
  }

  // Top X on the entire network
  async prepareTopFlows(json, dimension, fd, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);
    const target = options.intf && ('intf:' + options.intf) || options.tag && ('tag:' + options.tag) || options.mac || undefined;

    log.verbose('prepareTopFlows', dimension, fd, target || 'system', options.queryall ? 'last24' : [ begin, end ])
    log.debug(options)

    let sumFlowKey = null

    if(options.queryall) {
      sumFlowKey = await flowAggrTool.getLastSumFlow(target, dimension, fd);

      if (!sumFlowKey) {
        log.warn('Aggregation not found', target || 'system', dimension, fd)
        return []
      }

      const ts = this._getTimestamps(sumFlowKey);
      if (ts) {
        begin = ts.begin
        end = ts.end
      }
    } else {
      sumFlowKey = flowAggrTool.getSumFlowKey(target, dimension, begin, end, fd);
    }

    const traffic = await flowAggrTool.getTopSumFlowByKey(sumFlowKey, options.limit || 200);

    traffic.forEach(f => {
      f.begin = begin;
      f.end = end;
    })

    const enriched = await flowTool.enrichWithIntel(traffic, !dimension.startsWith('dns') && dimension != 'local');

    json.flows[`${dimension}${fd ? `:${fd}` : ""}`] = enriched.sort((a, b) => {
      return b.count - a.count;
    });
    log.verbose('prepareTopFlows ends', dimension, fd, target, options.queryall ? 'last24' : [ begin, end ])
    return json.flows[`${dimension}${fd ? `:${fd}` : ""}`]
  }

  // "sumflow:8C:29:37:BF:4A:86:upload:1505073000:1505159400"
  _getTimestamps(sumFlowKey) {
    if(!sumFlowKey) return null

    const pattern = /:([^:]*):([^:]*)$/
    const result = sumFlowKey.match(pattern)
    if(!result) return null

    return {
      begin: toInt(result[1]),
      end: toInt(result[2])
    }
  }

  _dedupActivityDuration(allFlows, minIdle = 180) { // if the gap between the consecutive flows are less than minIdle seconds, they will still be merged together as one session
    // dedup duration
    // 00:00 - 00:15  duration 15
    // 00:03 - 00:18  duration 15
    // shoud dedup to 00:00 - 00:18 duration 18
    let idleThreshold = minIdle;
    for (let i = allFlows.length - 1; i > 0; i--) {
      const flow = allFlows[i];
      const nextFlow = allFlows[i - 1];
      if (flow.ts + flow.duration < nextFlow.ts - idleThreshold) {
        // reset idleThresold to minIdle if next flow is out of session window
        idleThreshold = minIdle;
        continue;
      } else if (flow.ts + flow.duration > nextFlow.ts + nextFlow.duration) {
        flow.download += nextFlow.download;
        flow.upload += nextFlow.upload;
        allFlows.splice(i - 1, 1);
        i = allFlows.length;
      } else if (flow.ts + flow.duration <= nextFlow.ts + nextFlow.duration) {
        flow.download += nextFlow.download;
        flow.upload += nextFlow.upload;
        flow.duration = nextFlow.ts + nextFlow.duration - flow.ts;
        allFlows.splice(i - 1, 1);
        i = allFlows.length;
      }
      // dynamically adjust idleThreshold based on current flow curation
      idleThreshold = Math.min(Math.max(flow.duration / 3, idleThreshold), 1200);
    }
  }

  async prepareAppTimeUsage(json, options) {
    const begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    const end = options.end || (begin + 3600);

    const supportedApps = await TimeUsageTool.getSupportedApps();
    const apps = _.intersection(_.has(options, "apps") && _.isArray(options.apps) ? options.apps : supportedApps, supportedApps);
    let uid = null;
    let containerUid = null;
    if (options.mac) {
      uid = options.mac;
      // only retrieve time usage stats of a device in a specific group/network
      if (options.tag)
        containerUid = `tag:${options.tag}`;
      else if (options.intf)
        containerUid = `intf:${options.intf}`;
    } else if (options.tag)
      uid = `tag:${options.tag}`;
    else if (options.intf)
      uid = `intf:${options.intf}`;
    else
      uid = "global";
    const {appTimeUsage, appTimeUsageTotal, categoryTimeUsage} = await TimeUsageTool.getAppTimeUsageStats(uid, containerUid, apps, begin, end, options.granularity, options.mac ? true : false);

    json.appTimeUsage = appTimeUsage;
    json.appTimeUsageTotal = appTimeUsageTotal;
    json.categoryTimeUsage = categoryTimeUsage;

    const stats = await TimeUsageTool.getAppTimeUsageStats(uid, containerUid, ["internet"], begin, end, options.granularity, options.mac ? true : false);
    json.internetTimeUsage = _.get(stats, ["appTimeUsage", "internet"]);
  }

  async syncHostAppTimeUsageToTags(uid, options) {
    const tags = [];
    let hostInfo = hostManager.getHostFastByMAC(uid);
    if (!hostInfo)
      hostInfo = identityManager.getIdentityByGUID(uid);
    if (!hostInfo) {
      log.error(`Device with uid ${uid} is not found, cannot sync host app time usage to tags`);
      return;
    }
    const transitiveTags = await hostInfo.getTransitiveTags();
    for (const tagType of Object.keys(transitiveTags))
      tags.push(...Object.keys(transitiveTags[tagType]));
    if (_.isEmpty(tags))
      return;
    
    const timezone = sysManager.getTimezone();
    // default value of begin is start of today
    let begin = (timezone ? moment().tz(timezone) : moment()).startOf("day").unix();
    if (options.begin) // align to hour
      begin = (timezone ? moment(options.begin * 1000).tz(timezone) : moment(options.begin * 1000)).startOf("hour").unix();
    let end = (timezone ? moment().tz(timezone) : moment()).startOf("hour").unix() + 3600;
    if (options.end) // align to next hour because end is excluded
      end = (timezone ? moment(options.end * 1000).tz(timezone) : moment(options.end * 1000)).startOf("hour").unix() + 3600;
    log.info(`Going to sync app time usage of ${uid} from ${begin} to ${end} into tags: `, tags);
    const apps = await TimeUsageTool.getSupportedApps();
    apps.push("internet");
    const stats = await TimeUsageTool.getAppTimeUsageStats(uid, null, apps, begin, end, null, true);
    
    await Promise.all(apps.map(async (app) => {
      const uids = {};
      const intervals = _.get(stats, ["appTimeUsage", app, "devices", uid, "intervals"]);
      if (!_.isArray(intervals))
        return;
      await Promise.all(intervals.map(async (interval) => {
        const {begin, end} = interval;
        let hour = 0;
        for (let t = begin; t <= end; t += 60) {
          const h = Math.floor(t / 3600);
          const minOfHour = Math.floor((t - h * 3600) / 60);
          for (const tag of tags) {
            if (h !== hour)
              await TimeUsageTool.recordUIDAssociation(`tag:${tag}`, uid, h);
            const assocUid = `${uid}@tag:${tag}`;
            const oldVal = await TimeUsageTool.getBucketVal(assocUid, app, h, minOfHour);
            // do not set and incr minute bucket value on tag and uid-tag association if the minute is already set, keep this function idempotent
            if (isNaN(oldVal) || Number(oldVal) == 0) {
              await TimeUsageTool.setBucketVal(assocUid, app, h, minOfHour, "1");
              await TimeUsageTool.incrBucketVal(`tag:${tag}`, app, h, minOfHour);
              uids[`tag:${tag}`] = 1;
            }
            const category = await TimeUsageTool.getAppCategory(app);
            if (category) {
              const categoryOldVal = await TimeUsageTool.getBucketVal(assocUid, category, h, minOfHour);
              if (isNaN(categoryOldVal) || Number(categoryOldVal) == 0) {
                await TimeUsageTool.setBucketVal(assocUid, category, h, minOfHour, "1");
                await TimeUsageTool.incrBucketVal(`tag:${tag}`, category, h, minOfHour);
                uids[`tag:${tag}`] = 1;
              }
            }
          }
          hour = h;
        }
      })).catch((err) => {
        log.error(`Failed to sync intervals of app ${app} from ${uid}`, err.message);
      });
      sem.sendEventToFireMain({type: Message.MSG_APP_TIME_USAGE_BUCKET_INCR, app, uids: Object.keys(uids), suppressEventLogging: true});
    })).catch((err) => {
      log.error(`Failed to sync app time usage data from ${uid}`, err);
    });
  }
}


module.exports = NetBotTool;
