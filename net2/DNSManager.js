/*    Copyright 2016 Firewalla LLC
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

const iptool = require('ip');

const rclient = require('../util/redis_manager.js').getRedisClient()

const sysManager = require('./SysManager.js');

const asyncNative = require('../util/asyncNative.js');

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();

const IdentityManager = require('../net2/IdentityManager.js');

const flowUtil = require('../net2/FlowUtil.js');

const getPreferredBName = require('../util/util.js').getPreferredBName


const DNSQUERYBATCHSIZE = 5;

var hostManager = null;
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

  // Reslve v6 or v4 address into a local host
  resolveLocalHost(ip, callback) {
    callback = callback || function() {}

    this.resolveLocalHostAsync(ip)
       .then(res => callback(null, res))
       .catch(err => {
         callback(err);
       })
  }

  async resolveLocalHostAsync(ip) {
    let mac;

    if (iptool.isV4Format(ip)) {
      let data = await rclient.hgetallAsync("host:ip4:" + ip)
      if (data && data.mac) {
        mac = data.mac
      } else {
        const identity = IdentityManager.getIdentityByIP(ip);
        if (identity) {
          return {
            mac: IdentityManager.getGUID(identity),
            name: identity.getReadableName()
          }
        } else
          throw new Error('IP Not Found: ' + ip);
      }
    } else if (iptool.isV6Format(ip)) {
      let data = await rclient.hgetallAsync("host:ip6:" + ip)
      if (data && data.mac) {
        mac = data.mac
      } else {
        throw new Error('IP Not Found: ' + ip);
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

  // will place an x over flag or f if the flow is not really valid ...
  // such as half tcp session
  //
  // incase packets leaked via bitbridge, need to see how much they are and
  // consult the blocked list ...
  //
  // if x is there, the flow should not be used or presented.  It only be used
  // for purpose of accounting

  async query(list, ipsrc, ipdst, deviceMac) {

    // use this as cache to calculate how much intel expires
    // no need to call Date.now() too many times.
    if (hostManager == null) {
      let HostManager = require("../net2/HostManager.js");
      hostManager = new HostManager();
    }

    if (list == null || list.length == 0) {
      return;
    }

    return asyncNative.eachLimit(list, DNSQUERYBATCHSIZE, async(o) => {
      // resolve++;

      const _ipsrc = o[ipsrc]
      const _ipdst = o[ipdst]
      const _deviceMac = deviceMac && o[deviceMac];
      try {
        if(sysManager.isLocalIP(_ipsrc)) {
          if (_deviceMac && hostTool.isMacAddress(_deviceMac)) {
            await this.enrichDeviceMac(_deviceMac, o, "src");
          } else {
            // enrichDeviceCount++;
            if (_deviceMac && IdentityManager.isGUID(_deviceMac))
              this.enrichIdentity(_deviceMac, o, "src");
            else
              await this.enrichDeviceIP(_ipsrc, o, "src");
          }
        } else {
          // enrichDstCount++;
            await this.enrichDestIP(_ipsrc, o, "src");
        }

        if(sysManager.isLocalIP(_ipdst)) {
          if (_deviceMac && hostTool.isMacAddress(_deviceMac)) {
            await this.enrichDeviceMac(_deviceMac, o, "dst");
          } else {
            // enrichDeviceCount++;
            if (_deviceMac && IdentityManager.isGUID(_deviceMac))
              this.enrichIdentity(_deviceMac, o, "dst");
            else
              await this.enrichDeviceIP(_ipdst, o, "dst");
          }
        } else {
          // enrichDstCount++;
          await this.enrichDestIP(_ipdst, o, "dst")
        }
      } catch(err) {
        log.error(`Failed to enrich ip: ${_ipsrc}, ${_ipdst}`, err);
      }

      if (o.category === 'intel') {
        return;
      }

      // don't run this if the category is intel
      if (o.fd == "in") {
        if (o.du && o.du < 0.0001) {
          //log.info("### NOT LOOKUP 1:",o);
          flowUtil.addFlag(o, 'x');
          return;
        }
        if (o.ob && o.ob == 0 && o.rb && o.rb < 1000) {
          //log.info("### NOT LOOKUP 2:",o);
          flowUtil.addFlag(o, 'x');
          return;
        }
        if (o.rb && o.rb < 1500) { // used to be 2500
          //log.info("### NOT LOOKUP 3:",o);
          flowUtil.addFlag(o, 'x');
          return;
        }
        if (o.pr && o.pr == 'tcp' && (o.rb == 0 || o.ob == 0) && o.ct && o.ct <= 1) {
          flowUtil.addFlag(o, 'x');
          log.debug("### NOT LOOKUP 4:", o);
          return;
        }
      } else {
        if (o.pr && o.pr == 'tcp' && (o.rb == 0 || o.ob == 0)) {
          flowUtil.addFlag(o, 'x');
          log.debug("### NOT LOOKUP 5:", o);
          return;
        }
      }
    })
  }

  enrichIdentity(guid, flowObject, srcOrDest) {
    if (!guid)
      return;
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      if (srcOrDest === "src") {
        flowObject["shname"] = identity.getReadableName();
      } else {
        flowObject["dhname"] = identity.getReadableName();
      }
      flowObject.mac = IdentityManager.getGUID(identity);
    }
  }

  async enrichDeviceMac(mac, flowObject, srcOrDest) {
    if (!mac)
      return;
    mac = mac.toUpperCase();
    await hostTool.getMACEntry(mac).then((macEntry) => {
      if (macEntry) {
        if(srcOrDest === "src") {
          flowObject["shname"] = getPreferredBName(macEntry);
        } else {
          flowObject["dhname"] = getPreferredBName(macEntry);
        }
        flowObject.mac = mac;
      }
    }).catch((err) => {});
  }

  async enrichDeviceIP(ip, flowObject, srcOrDest) {
    try {
      const macEntry = await hostTool.getMacEntryByIP(ip)
      if(macEntry) {
        if(srcOrDest === "src") {
          flowObject["shname"] = getPreferredBName(macEntry)
        } else {
          flowObject["dhname"] = getPreferredBName(macEntry)
        }

        flowObject.mac = macEntry.mac
      }
    } catch(err) {
      // do nothing
    }
  }

  async enrichDestIP(ip, flowObject, srcOrDest) {
    try {
      const intel = await intelTool.getIntel(ip)
      if(intel) {
        if(intel.host) {
          if(srcOrDest === "src") {
            flowObject["shname"] = intel.host
          } else {
            flowObject["dhname"] = intel.host
          }
        }

        if(intel.org) {
          flowObject.org = intel.org
        }

        if(intel.app) {
          flowObject.app = intel.app
          flowObject.appr = intel.app        // ???
        }

        if(intel.category) {
          flowObject.category = intel.category
        }

        flowObject.intel = intel
      }
    } catch(err) {
      // do nothing
    }
  }
}
