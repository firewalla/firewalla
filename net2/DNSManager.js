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

const net = require('net');

const rclient = require('../util/redis_manager.js').getRedisClient()
const asyncNative = require('../util/asyncNative.js');

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();

const IdentityManager = require('../net2/IdentityManager.js');

const _ = require('lodash');
const URL = require("url");

const DNSQUERYBATCHSIZE = 5;

var instance = null;


module.exports = class DNSManager {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  async resolveMac(mac) {
    if (mac == null) {
      return null
    }
    return hostTool.getMACEntry(mac)
  }

  async resolveLocalHostAsync(ip) {
    let mac;

    if (net.isIPv4(ip)) {
      let data = await rclient.hgetallAsync("host:ip4:" + ip)
      if (data && data.mac) {
        mac = data.mac
      } else {
        log.warn('IP Not Found: ' + ip);
        return null
      }
    } else if (net.isIPv6(ip)) {
      let data = await rclient.hgetallAsync("host:ip6:" + ip)
      if (data && data.mac) {
        mac = data.mac
      } else {
        log.warn('IP Not Found: ' + ip);
        return null
      }
    } else {
      log.error("ResolveHost:BadIP", ip);
      throw new Error('bad ip');
    }

    return hostTool.getMACEntry(mac);
  }

  findHostWithIP(ip, callback) {
    let key = "host:ip4:" + ip;
    log.debug("DNS:FindHostWithIP", key, ip);
    rclient.hgetall(key, (err, data) => {
      let mackey = "host:mac:" + data.mac;
      rclient.hgetall(mackey, (err, data) => {
        callback(mackey, err, data);
      });
    });
  }

/*
> [ { address: '104.20.23.46', family: 4 },
  { address: '104.20.22.46', family: 4 },
  { address: '2400:cb00:2048:1::6814:162e', family: 6 },
  { address: '2400:cb00:2048:1::6814:172e', family: 6 } ]
*/

  // Enrich aggregated flows (from FlowManager.summarizeConnections) in place with the
  // local device name, remote host name and intel. Flows are in raw format (sh/dh/fd/
  // mac/appHosts). This is only called from FlowMonitor
  async enrichFlows(flows) {
    if (_.isEmpty(flows)) return;

    const HostManager = require("../net2/HostManager.js");
    const hostManager = new HostManager();

    return asyncNative.eachLimit(flows, DNSQUERYBATCHSIZE, async o => {
      try {
        let monitorable;
        if (o.mac && hostTool.isMacAddress(o.mac)) {
          monitorable = hostManager.getHostFastByMAC(o.mac);
        } else if (o.mac && IdentityManager.isGUID(o.mac)) {
          monitorable = IdentityManager.getIdentityByGUID(o.mac);
        }

        if (monitorable) {
          if (o.fd == 'in') {
            o.shname = monitorable.getReadableName();
          } else {
            o.dhname = monitorable.getReadableName();
          }
          // o.mac == monitorable.getGUID()
        }
        await this.enrichDestIP(o);
        this.enrichHttpFlow(o);
      } catch (err) {
        log.error('Failed to enrich flow', o.sh, o.dh, err);
      }
    })
  }

  // if any related URL of the flow is flagged as intel, override flow intel with it
  enrichHttpFlow(conn) {
    delete conn.uids;
    const urls = conn.urls;
    const category = conn.intel && conn.intel.category || intelTool.numberToCategory(conn.c)
    if (_.isEmpty(urls) || category === 'intel') return;
    for (const url of urls) {
      if (url && url.category === 'intel') {
        if (!conn.intel) conn.intel = {};
        for (const key of ["category", "cc", "cs", "t", "v", "s", "updateTime"]) {
          if (url[key])
            conn.intel[key] = url[key];
        }
        const parsedInfo = URL.parse(url.url);
        if (parsedInfo && parsedInfo.hostname) {
          conn.intel.host = parsedInfo.hostname;
        }
        conn.intel.fromURL = "1";
        break;
      }
    }
  }

  async enrichDestIP(flow) {
    const ip = flow.fd == 'in' ? flow.dh : flow.sh;
    const setRemoteName = (host) => {
      if (!host) return;
      if (flow.fd == 'out')
        flow.shname = host;
      else
        flow.dhname = host;
    };

    try {
      if (intelTool.isInlineIntelReady()) {
        // the flow record carries an intel snapshot baked at write time: c = coded
        // category, af (-> appHosts) = resolved remote host. Decode locally
        // instead of reading intel:ip; FlowMonitor fetches the full intel:ip record on
        // demand right before generating an alarm (prepareAlarmIntel)
        const category = intelTool.numberToCategory(flow.c);
        if (category) flow.category = category;
        // if (flow.a) flow.app = flow.a;
        setRemoteName(flow.appHosts && flow.appHosts[0]);
        return;
      }

      const intel = await intelTool.getIntel(ip, flow.appHosts);
      setRemoteName(flow.appHosts && flow.appHosts[0] || intel && intel.host);
      flow.intel = intel;
      Object.assign(flow, _.pick(intel, ['category', 'app', 'org']));
    } catch (err) {
      log.error('Failed to enrich remote', ip, err.message);
    }
  }
}
