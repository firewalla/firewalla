/*    Copyright 2016-2023 Firewalla Inc.
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

const LogQuery = require('./LogQuery.js')

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const TypeFlowTool = require('../flow/TypeFlowTool.js')
const typeFlowTool = {
  app: new TypeFlowTool('app'),
  category: new TypeFlowTool('category')
}

const auditTool = require('./AuditTool')

const _ = require('lodash');

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

  _enrichCountryInfo(flow) {
    let sh = flow.sh;
    let dh = flow.dh;
    let lh = flow.lh;

    if (sh === lh) {
      flow.country = intelTool.getCountry(dh)
    } else {
      flow.country = intelTool.getCountry(sh)
    }
  }

  async prepareRecentFlows(json, options) {
    log.verbose('prepareRecentFlows', JSON.stringify(options))
    options = options || {}
    this.checkCount(options)
    const macs = await this.expendMacs(options)
    if (!("flows" in json)) {
      json.flows = {};
    }

    const feeds = []
    if (options.direction) {
      feeds.push(... this.expendFeeds({macs, direction: options.direction}))
    } else {
      feeds.push(... this.expendFeeds({macs, direction: 'in'}))
      feeds.push(... this.expendFeeds({macs, direction: 'out'}))
    }
    if (options.audit) {
      feeds.push(... auditTool.expendFeeds({macs, block: true}))
    }
    if (options.auditDNSSuccess) {
      feeds.push(... auditTool.expendFeeds({macs, block: false}))
    }
    delete options.audit
    delete options.auditDNSSuccess
    let recentFlows = await this.logFeeder(options, feeds)

    json.flows.recent = recentFlows;
    log.verbose('prepareRecentFlows ends', JSON.stringify(options))
    return recentFlows
  }

  // convert flow json to a simplified json format that's more readable by app
  toSimpleFormat(flow) {
    let f = {
      ltype: 'flow',
      type: 'ip'
    };
    f.ts = flow._ts; // _ts:update/record time, front-end always show up this
    f.fd = flow.fd;
    f.count = flow.ct || 1,
    f.duration = flow.du
    f.intf = flow.intf;
    f.tags = flow.tags;
    if (_.isObject(flow.af) && !_.isEmpty(flow.af)) {
      f.appHosts = Object.keys(flow.af);
    }

    if (flow.rl) {
      // real IP:port of the client in VPN network
      f.rl = flow.rl;
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
        aggrResults[tenminTS] = {
          ts: tenminTS,
          ob: x.ob + old.ob,
          rb: x.rb + old.rb
        }
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
    const end = options.end || Math.floor(new Date() / 1000);
    const begin = options.begin || end - 3600 * 6; // 6 hours
    const direction = options.direction || 'in';

    const key = util.format("flow:conn:%s:%s", direction, target);

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
      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.direction = "in";
      const t_in = await this._getTransferTrend(deviceMAC, destinationIP, optionsCopy);
      transfers.push.apply(transfers, t_in);
    }

    if (!options.direction || options.direction === "out") {
      const optionsCopy = JSON.parse(JSON.stringify(options));
      optionsCopy.direction = "out";
      const t_out = await this._getTransferTrend(deviceMAC, destinationIP, optionsCopy);
      transfers.push.apply(transfers, t_out);
    }
    return this._aggregateTransferBy10Min(transfers);
  }

  getLogKey(mac, options) {
    return util.format("flow:conn:%s:%s", options.direction, mac);
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
