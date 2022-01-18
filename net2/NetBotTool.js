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
const log = require('./logger.js')(__filename);

const util = require('util');

const FlowAggrTool = require('./FlowAggrTool');
const flowAggrTool = new FlowAggrTool();
const ActivityAggrTool = require('../flow/ActivityAggrTool')

const HostTool = require('./HostTool');
const hostTool = new HostTool();

const TypeFlowTool = require('../flow/TypeFlowTool.js')

const flowTool = require('./FlowTool.js');

const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const identityManager = require('../net2/IdentityManager.js');

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
    return this.prepareTopFlows(json, "download", options);
  }

  prepareTopUploadFlows(json, options) {
    return this.prepareTopFlows(json, "upload", options);
  }

  async prepareCategoryActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting category flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "category", begin, end);

    let traffic = await flowAggrTool.getCategoryActivitySumFlowByKey(sumFlowKey, 50);

    traffic.sort((a, b) => {
      return b.count - a.count;
    });

    for (const t of traffic) {
      let mac = t.device;
      let host = await hostTool.getMACEntry(mac);
      let name = hostTool.getHostname(host);
      t.deviceName = name;
    }

    json.flows.categories = traffic;
  }

  // app
  async prepareAppActivitiesFlows(json, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);

    let endString = new Date(end * 1000).toLocaleTimeString();
    let beginString = new Date(begin * 1000).toLocaleTimeString();

    log.info(util.format("Getting app flows between %s and %s", beginString, endString));

    let sumFlowKey = flowAggrTool.getSumFlowKey(undefined, "app", begin, end);

    let traffic = await flowAggrTool.getAppActivitySumFlowByKey(sumFlowKey, 50);

    traffic.sort((a, b) => {
      return b.count - a.count;
    });

    for (const t of traffic) {
      let mac = t.device;
      let host = await hostTool.getMACEntry(mac);
      let name = hostTool.getHostname(host);
      t.deviceName = name;
    }

    json.flows.apps = traffic;
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

    log.verbose(`[Cache] Getting ${dimension} detail flows between ${beginString} and ${endString}`)

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
    this._dedupActivityDuration(flows);
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
        allMacs = hostManager.getActiveMACs()
        allMacs.push(... identityManager.getAllIdentitiesGUID())
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
        allFlows[type].push(... typeFlows)
      }

      allFlows[type] = allFlows[type]
        .filter((f) => f.duration >= 5) // ignore activities less than 5 seconds
        .sort((a, b) => {
          return b.ts - a.ts;
        });
      if (!allFlows[type].length) delete allFlows[type]
    }
    this._dedupActivityDuration(allFlows);
    json.flows[key] = allFlows
    return allFlows
  }

  // Top X on the entire network
  async prepareTopFlows(json, trafficDirection, options) {
    if (!("flows" in json)) {
      json.flows = {};
    }

    let begin = options.begin || (Math.floor(new Date() / 1000 / 3600) * 3600)
    let end = options.end || (begin + 3600);
    const target = options.intf && ('intf:' + options.intf) || options.tag && ('tag:' + options.tag) || options.mac || undefined;

    log.verbose('prepareTopFlows', trafficDirection, target || 'system', options.queryall ? 'last24' : [ begin, end ])
    log.debug(options)

    let sumFlowKey = null

    if(options.queryall) {
      sumFlowKey = await flowAggrTool.getLastSumFlow(target, trafficDirection);

      if (!sumFlowKey) {
        log.warn('Aggregation not found', target || 'system', trafficDirection)
        return []
      }

      const ts = this._getTimestamps(sumFlowKey);
      if (ts) {
        begin = ts.begin
        end = ts.end
      }
    } else {
      sumFlowKey = flowAggrTool.getSumFlowKey(target, trafficDirection, begin, end);
    }

    const traffic = await flowAggrTool.getTopSumFlowByKey(sumFlowKey, 50);

    traffic.forEach(f => {
      f.begin = begin;
      f.end = end;
    })

    const enriched = await flowTool.enrichWithIntel(traffic);

    json.flows[trafficDirection] = enriched.sort((a, b) => {
      return b.count - a.count;
    });
    log.verbose('prepareTopFlows ends', trafficDirection, target, options.queryall ? 'last24' : [ begin, end ])
    return json.flows[trafficDirection]
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

  _dedupActivityDuration(allFlows) {
    // dedup duration
    // 00:00 - 00:15  duration 15
    // 00:03 - 00:18  duration 15
    // shoud dedup to 00:00 - 00:18 duration 18
    for (const type in allFlows) {
      for (let i = allFlows[type].length - 1; i >0; i--) {
        const flow = allFlows[type][i];
        const nextFlow = allFlows[type][i - 1];
        if (flow.ts + flow.duration < nextFlow.ts) {
          continue;
        } else if (flow.ts + flow.duration > nextFlow.ts + nextFlow.duration) {
          flow.download += nextFlow.download;
          flow.upload += nextFlow.upload;
          allFlows[type].splice(i - 1, 1);
          i = allFlows[type].length;
        } else if (flow.ts + flow.duration <= nextFlow.ts + nextFlow.duration) {
          flow.download += nextFlow.download;
          flow.upload += nextFlow.upload;
          flow.duration = nextFlow.ts + nextFlow.duration - flow.ts;
          allFlows[type].splice(i - 1, 1);
          i = allFlows[type].length;
        }
      }
    }
  }
}


module.exports = NetBotTool;
