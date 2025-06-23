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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const util = require('util');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const LogQuery = require('./LogQuery.js')

const TypeFlowTool = require('../flow/TypeFlowTool.js')
const typeFlowTool = {
  app: new TypeFlowTool('app'),
  category: new TypeFlowTool('category')
}

const auditTool = require('./AuditTool')

const _ = require('lodash');
const Constants = require('./Constants.js');

const LOOK_AHEAD_INTERVAL = 3600

class FlowTool extends LogQuery {
  trimFlow(flow) {
    if(!flow)
      return;

    if("flows" in flow)
      delete flow.flows;

    if("pf" in flow)
      delete flow.pf;

    if("af" in flow)
      delete flow.af;

//    if("f" in flow)
//      delete flow.f;
    if("uids_array" in flow) {
      flow.uids = flow.uids_array.filter((v, i) => {
        return flow.uids_array.indexOf(v) === i;
      });
      delete flow.uids_array;
    }
  }

  mergeLog(targetFlow, flow) {
    targetFlow.download += flow.download;
    targetFlow.upload += flow.upload;
    targetFlow.duration += flow.duration;
    if (targetFlow.ts < flow.ts) { // ts had been converted to the _ts: update/record time
      targetFlow.ts = flow.ts;
    }
  }

  shouldMerge(targetFlow, flow) {
    if (targetFlow.type || flow.type) return auditTool.shouldMerge()
    const compareKeys = ['device', 'ip', 'fd', 'port', 'protocol'];
    return _.isEqual(_.pick(targetFlow, compareKeys), _.pick(flow, compareKeys));
  }

  includeFirewallaInterfaces() { return false }

  isLogValid(flow, options) {
    if (!super.isLogValid(flow, options)) return false

    let o = flow;

    if ( !('upload' in o) || !('download' in o) ) {
      return false
    }
    if (o.upload == 0 && o.download == 0) {
      // ignore zero length flows
      return false;
    }
    return true;
  }

  // options here no longer serve as filter, just to query and format results
  optionsToFeeds(options, macs) {
    log.debug('optionsToFeeds', options)
    const feedsArray = []
    if (options.regular) {
      if (macs[0] == 'system')
        feedsArray.push(this.expendFeeds({macs}))
      else {
        feedsArray.push(this.expendFeeds({macs, direction: 'in'}))
        feedsArray.push(this.expendFeeds({macs, direction: 'out'}))
      }
    }
    if (options.local) {
      // a local flow will be recorded in both src and dst host key, need to deduplicate flows on the two hosts if both hosts are included in macs
      if (macs[0] == 'system')
        feedsArray.push(this.expendFeeds({macs, local: true}))
      else
        feedsArray.push(this.expendFeeds({macs, local: true, exclude: {dstMac: macs, fd: "out"}}))
    }

    return [].concat(... feedsArray)
  }

  // max of min ts in all feeds, ignoring feed that has no flow
  async getValidGlobalTS(feeds) {
    const multi = []
    for (const feed of feeds) {
      const key = feed.base.getLogKey(feed.options.mac, feed.options);
      multi.push(['zrangebyscore', key, 0, '+inf', 'LIMIT', 0 , 1, 'WITHSCORES']);
    }
    const results = await rclient.pipelineAndLog(multi);
    // log.debug('getValidGlobalTS:', JSON.stringify(multi), results)
    let ts = null;
    for (const result of results) {
      const t = Number(result[1]);
      if (t && t > ts) ts = t;
    }

    return ts
  }

  async prepareRecentFlows(options) {
    log.verbose('prepareRecentFlows', JSON.stringify(options))
    options = this.checkArguments(options || {})

    let results = []
    let queryDone = false
    // query system flows first if possible
    if (!options.mac && !options.macs && !options.tag && !options.intf) {
      const feeds = this.optionsToFeeds(options, ['system']).concat(
        auditTool.optionsToFeeds(options, ['system'])
      )

      const sysOptions = JSON.parse(JSON.stringify(options))

      let skip = false

      const validTS = await this.getValidGlobalTS(feeds)
      log.debug(`validTS for system flows: ${validTS}`)
      if (sysOptions.ts <= validTS)
        skip = true
      else if (sysOptions.asc)
        queryDone = true
      else if (sysOptions.ets < validTS)
        sysOptions.ets = validTS
      else
        queryDone = true

      if (!skip) {
        results = await this.logFeeder(sysOptions, feeds, true)
        if (results.length >= sysOptions.count) {
          log.verbose(`got ${results.length} system flows, query done`)
          results = results.slice(0, sysOptions.count);
          queryDone = true;
        } else {
          options.count -= results.length;
          if (results.length)
            options.ts = validTS;
          log.verbose(`got ${results.length} system flows, ${options.count} left, starting ${options.ts} to ${options.ets}`)
        }
      }
    }

    if (!queryDone) {
      const macs = await this.expendMacs(options)

      const feeds = this.optionsToFeeds(options, macs).concat(
        auditTool.optionsToFeeds(options, macs)
      )

      results = results.concat(await this.logFeeder(options, feeds))
    }

    // log.verbose('prepareRecentFlows ends', JSON.stringify(options))
    return results
  }

  // convert flow json to a simplified json format that's more readable by app
  toSimpleFormat(flow, options = {}) {
    let f = {
      ltype: 'flow',
      type: 'ip'
    };
    f.ts = flow._ts; // _ts:update/record time, front-end always show up this
    f.fd = flow.fd;
    f.count = flow.ct || 1,
    f.duration = flow.du
    if (flow.intf) f.intf = networkProfileManager.prefixMap[flow.intf] || flow.intf
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const flowKey = Constants.TAG_TYPE_MAP[type].flowKey
      if (flow[flowKey]) f[flowKey] = flow[flowKey];
    }
    if (_.isObject(flow.af) && !_.isEmpty(flow.af)) {
      f.appHosts = Object.keys(flow.af);
    }

    if (flow.rl) {
      // real IP:port of the client in VPN network
      f.rl = flow.rl;
    }

    if (flow.oIntf)
      f.oIntf = networkProfileManager.prefixMap[flow.oIntf] || flow.oIntf
    if (flow.dIntf)
      f.dIntf = networkProfileManager.prefixMap[flow.dIntf] || flow.dIntf

    if (flow.sigs)
      f.sigs = flow.sigs;

    // allow rule id
    if (flow.apid && Number(flow.apid)) {
      f.apid = Number(flow.apid);
    }

    // route rule id
    if (flow.rpid && Number(flow.rpid)) {
      f.rpid = Number(flow.rpid);
    }

    f.protocol = flow.pr;

    try {
      if(flow.lh === flow.sh) {
        f.port = Number(flow.dp);
        f.devicePort = Number(flow.sp[0]);
      } else {
        f.port = Number(flow.sp[0]);
        f.devicePort = Number(flow.dp);
      }
    } catch(err) {
    }

    if(flow.lh === flow.sh) {
      f.ip = flow.dh;
      f.deviceIP = flow.sh;
      f.upload = flow.ob;
      f.download = flow.rb;
    } else {
      f.ip = flow.sh;
      f.deviceIP = flow.dh;
      f.upload = flow.rb;
      f.download = flow.ob;
    }

    if (options.local) {
      f.dstMac = flow.dmac
      f.local = true
      if (flow.drl)
        f.drl = flow.drl;
      if (flow.dstTags)
        f.dstTags = flow.dstTags;
    }

    return f;
  }

  _aggregateTransferBy10Min(results) {
    const aggrResults = {};
    results.forEach((x) => {
      const ts = x.ts;
      const tenminTS = Math.floor(Number(ts) / 600) * 600;
      if(!aggrResults[tenminTS]) {
        aggrResults[tenminTS] = {
          ts: tenminTS,
          ob: x.ob,
          rb: x.rb
        }
      } else {
        const old = aggrResults[tenminTS];
        old.ob += x.ob
        old.rb += x.rb
      }
    })
    return Object.values(aggrResults).sort((x,y) => {
      if(x.ts > y.ts) {
        return 1;
      } else if(x.ts === y.ts) {
        return 0;
      } else {
        return -1;
      }
    });
  }

  async _getTransferTrend(target, destinationIP, options) {
    options = options || {};
    const end = options.end || Math.floor(Date.now() / 1000);
    const begin = options.begin || end - 3600 * 6; // 6 hours
    const key = this.getLogKey(target, options);

    const results = await rclient.zrangebyscoreAsync([key, begin, end]);

    if(results === null || results.length === 0) {
      return [];
    }

    const list = results
      .map((jsonString) => {
        try {
          return JSON.parse(jsonString);
        } catch(err) {
          log.error(`Failed to parse json string: ${jsonString}, err: ${err}`);
          return null;
        }
      })
      .filter((x) => x !== null)
      .filter((x) => x.sh === destinationIP || x.dh === destinationIP)
      .map((x) => {
        return {
          ts: x.ts,
          ob: x.sh === destinationIP ? x.rb : x.ob, // ob stands for number of bytes transferred from local to remote, regardless of flow direction
          rb: x.sh === destinationIP ? x.ob : x.rb  // rb strands for number of bytes transferred from remote to local, regardless of flow direction
        }
      })

    return list;
  }

  async getTransferTrend(deviceMAC, destinationIP, options) {
    options = options || {};

    const transfers = [];

    if (!options.direction || options.direction === "in") {
      const t_in = await this._getTransferTrend(deviceMAC, destinationIP, Object.assign({direction: 'in'}, options));
      transfers.push.apply(transfers, t_in);
    }

    if (!options.direction || options.direction === "out") {
      const t_out = await this._getTransferTrend(deviceMAC, destinationIP, Object.assign({direction: 'out'}, options));
      transfers.push.apply(transfers, t_out);
    }
    return this._aggregateTransferBy10Min(transfers);
  }

  getLogKey(mac, options) {
    if (options.local)
      return `flow:local:${mac}`
    else if (options.direction)
      return util.format("flow:conn:%s:%s", options.direction || 'in', mac);
    else
      return 'flow:conn:system'
  }

  addFlow(mac, type, flow) {
    let key = this.getLogKey(mac, {direction: type} );

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return rclient.zaddAsync(key, flow.ts, JSON.stringify(flow));
  }

  removeFlow(mac, type, flow) {
    let key = this.getLogKey(mac, {direction: type} );

    if(typeof flow !== 'object') {
      return Promise.reject("Invalid flow type: " + typeof flow);
    }

    return rclient.zremAsync(key, JSON.stringify(flow))
  }

  // legacy api, returns raw redis data
  queryFlows(mac, type, begin, end) {
    let key = this.getLogKey(mac, {direction: type});

    return rclient.zrangebyscoreAsync(key, "(" + begin, end) // char '(' means open interval
      .then(flowStrings =>
        flowStrings.map(JSON.parse).filter(x => ('ob' in x) && ('rb' in x) && (x.ob != 0 || x.rb != 0))
      )
  }

  getDestIP(flow) {
    if(!flow) {
      return null
    }

    if(flow.lh === flow.sh) {
      return flow.dh;
    } else {
      return flow.sh;
    }
  }

  getDownloadTraffic(flow) {
    if(flow.lh === flow.sh) {
      return flow.rb;
    } else {
      return flow.ob;
    }
  }

  getUploadTraffic(flow) {
    if(flow.lh === flow.sh) {
      return flow.ob;
    } else {
      return flow.rb;
    }
  }

  async getDeviceLogs(options) {
    // use TypeFlow as look ahead to cut empty queries in advance
    if (options.category || options.app) {
      let found = false
      while (options.asc ? options.ts < options.ets : options.ts > options.ets) {
        let allDimensionFound = true
        const min = options.asc ? options.ts : options.ets
        const max = options.asc ? options.ets : options.ts
        for (const dimension of ['app', 'category']) {
          if (options[dimension]) {
            const key = typeFlowTool[dimension].getTypeFlowKey(options.mac, options[dimension])
            const count = await rclient.zcountAsync(key, min, max)
            if (!count) allDimensionFound = false
          }
        }
        if (allDimensionFound) {
          found = true
          break
        }
        options.ts = options.asc ? options.ts + LOOK_AHEAD_INTERVAL : options.ts - LOOK_AHEAD_INTERVAL
      }
      if (!found) return []
    }

    return super.getDeviceLogs(options)
  }
}

module.exports = new FlowTool();
