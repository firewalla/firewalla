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
    } else {
      return rclient.hgetallAsync("host:mac:" + mac)
    }
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

  // Need to write code to drop the noise before calling this function.
  // this is a bit expensive due to the lookup part
  async query(list, ipsrc, ipdst, deviceMac, hostIndicatorsKeyName) {

    if (list == null || list.length == 0) {
      return;
    }

    const HostManager = require("../net2/HostManager.js");
    const hostManager = new HostManager();

    // this is now only called in FlowMonitor to enrich flow info
    return asyncNative.eachLimit(list, DNSQUERYBATCHSIZE, async(o) => {

      const _ipsrc = o[ipsrc]
      const _ipdst = o[ipdst]
      const _deviceMac = deviceMac && o[deviceMac];
      const _hostIndicators = hostIndicatorsKeyName && o[hostIndicatorsKeyName];
      try {
        let monitorable
        if (_deviceMac && hostTool.isMacAddress(_deviceMac)) {
          monitorable = hostManager.getHostFastByMAC(_deviceMac);
        } else {
          if (_deviceMac && IdentityManager.isGUID(_deviceMac))
            monitorable = IdentityManager.getIdentityByGUID(_deviceMac);
          else {
            monitorable = hostManager.getHostFastByMAC(o.fd == 'in' ? _ipsrc : _ipdst);
          }
        }

        if (monitorable) {
          if (o.fd == 'in') {
            o.shname = monitorable.getReadableName();
          } else {
            o.dhname = monitorable.getReadableName();
          }
          o.mac == monitorable.getGUID()
        }

        await this.enrichDestIP(o.fd == 'in' ? _ipdst : _ipsrc, o, _hostIndicators);

        this.enrichHttpFlow(o);

      } catch(err) {
        log.error(`Failed to enrich ip: ${_ipsrc}, ${_ipdst}`, err);
      }
    })
  }

  enrichHttpFlow(conn) {
    delete conn.uids;
    const urls = conn.urls;
    if (!_.isEmpty(urls) && conn.intel && conn.intel.c !== 'intel') {
      for (const url of urls) {
        if (url && url.category === 'intel') {
          for (const key of ["category", "cc", "cs", "t", "v", "s", "updateTime"]) {
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
  }

  async enrichDestIP(ip, flowObject, hostIndicators) {
    try {
      const intel = await intelTool.getIntel(ip, hostIndicators)

      if (intel.host) {
        if (flowObject.fd == 'out') {
          flowObject["shname"] = intel.host
        } else {
          flowObject["dhname"] = intel.host
        }
      }

      flowObject.intel = intel
      Object.assign(flowObject, _.pick(intel, ['category', 'app', 'org']))

    } catch(err) {
      // do nothing
    }
  }
}
