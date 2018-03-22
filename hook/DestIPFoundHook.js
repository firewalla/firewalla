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

let log = require('../net2/logger.js')(__filename, 'info');

let Hook = require('./Hook.js');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let country = require('../extension/country/country.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const f = require("../net2/Firewalla.js")

let Promise = require('bluebird');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let DNSManager = require('../net2/DNSManager.js');
let dnsManager = new DNSManager('info');

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

let flowUtil = require('../net2/FlowUtil.js');

let IP_SET_TO_BE_PROCESSED = "ip_set_to_be_processed";

let ITEMS_PER_FETCH = 100;
let QUEUE_SIZE_PAUSE = 2000;
let QUEUE_SIZE_RESUME = 1000;

let MONITOR_QUEUE_SIZE_INTERVAL = 10 * 1000; // 10 seconds;

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

class DestIPFoundHook extends Hook {

  constructor() {
    super();

    this.config.intelExpireTime = 2 * 24 * 3600; // two days
    this.pendingIPs = {};
  }

  appendNewIP(ip) {
    log.debug("Enqueue new ip for intels", ip, {});
    return rclient.zaddAsync(IP_SET_TO_BE_PROCESSED, 0, ip);
  }

  appendNewFlow(ip,fd) {
    let flow = {
       ip:ip,
       fd:fd
    };
    return rclient.zaddAsync(IP_SET_TO_BE_PROCESSED, 0, JSON.stringify(flow));
  }

  isFirewalla(host) {
    let patterns = [/\.encipher\.io$/,
      /^encipher\.io$/,
      /^firewalla\.com$/,
      /\.firewalla\.com$/];

    return patterns.filter(p => host.match(p)).length > 0;
  }

  aggregateIntelResult(ip, sslInfo, dnsInfo, cloudIntelInfos) {
    let intel = {
      ip: ip
    };

    // dns
    if(dnsInfo && dnsInfo.host) {
      intel.host = dnsInfo.host;
      intel.dnsHost = dnsInfo.host;
    }

    if(sslInfo && sslInfo.server_name) {
      intel.host = sslInfo.server_name
      intel.sslHost = sslInfo.server_name
      intel.org = sslInfo.O
    }

    // app
    cloudIntelInfos.forEach((info) => {

/*
      let hashes = [intel.ip, intel.host].map(
        x => flowUtil.hashHost(x).map(y => y.length > 1 && y[1])
      )
      hashes = [].concat.apply([], hashes);
*/

      // check if the host matches the result from cloud

      // FIXME: ignore IP check because intel result from cloud does
      // NOT have "ip" all the time.

      // In the future, intel result needs to be enhanced to support
      // batch query

      // if(hashes.filter(x => x === info.ip).length > 0) {
      if(info.apps) {
        intel.apps = JSON.stringify(info.apps);
        let keys = Object.keys(info.apps);
        if(keys && keys[0]) {
          intel.app = keys[0];
        }
      }

      if(info.c) {
        intel.category = info.c;
      }

      if(info.action && info.action.block) {
        intel.action = "block"
      }
      
      if(info.s) {
        intel.s = info.s;
      }
 
      if(info.t) {
        intel.t = info.t;
      }
      //      }
    });

    return intel;
  }

  getDomains(sslInfo, dnsInfo) {
    let domain = sslInfo && sslInfo.server_name;
    if(!domain) {
      domain = dnsInfo && dnsInfo.host;
    }

    let domains = [];
    if(domain)
      domains.push(domain);

    return domains;
  }

  enrichCountry(ip) {
    return country.getCountry(ip);
  }

  // this code shall be disabled in production.
  // workaroundIntelUpdate(intel) {
  //   if(intel.host.match(/weixin.qq.com$/) && !intel.apps) {
  //     intel.apps = JSON.stringify({"wechat" : "100"});
  //   }
  // }

  processIP(flow, options) {
    let ip = null;
    let fd = 'in';

    if (flow) {
      let parsed = null;
      try {
        parsed = JSON.parse(flow);
        if (parsed.fd) {
          fd = parsed.fd;
          ip = parsed.ip;
        } else {
          ip = flow;
          fd = 'in';
        }
      } catch(e) {
        ip = flow;
      }
    } 
    options = options || {};

    let skipRedisUpdate = options.skipUpdate;
    let forceRedisUpdate = options.forceUpdate;

    return async(() => {

      if(!skipRedisUpdate && !forceRedisUpdate) {
        let result = await (intelTool.intelExists(ip));

        if(result) {
          return;
        }
      }

      log.info("Found new IP " + ip + " fd " +fd+ " flow "+flow+", checking intels...");

      let sslInfo = await (intelTool.getSSLCertificate(ip));
      let dnsInfo = await (intelTool.getDNS(ip));

      let domains = this.getDomains(sslInfo, dnsInfo);
      let ips = [ip];

      let cloudIntelInfo = [];

      // ignore if domain contain firewalla domain
      if(domains.filter(d => this.isFirewalla(d)).length === 0) {
        cloudIntelInfo = await (intelTool.checkIntelFromCloud(ips, domains, fd));
      }

      // Update intel dns:ip:xxx.xxx.xxx.xxx so that legacy can use it for better performance
      let aggrIntelInfo = this.aggregateIntelResult(ip, sslInfo, dnsInfo, cloudIntelInfo);
      aggrIntelInfo.country = this.enrichCountry(ip) || ""; // empty string for unidentified country

      // this.workaroundIntelUpdate(aggrIntelInfo);

      if(!skipRedisUpdate) {
        await (intelTool.addIntel(ip, aggrIntelInfo, this.config.intelExpireTime));
      }

      return aggrIntelInfo;

    })().catch((err) => {
      log.error(`Failed to process IP ${ip}, error: ${err}`);
      return null;
    })
  }

  job() {
    return async(() => {
      log.debug("Checking if any IP Addresses pending for intel analysis...")

      let ips = await (rclient.zrangeAsync(IP_SET_TO_BE_PROCESSED, 0, ITEMS_PER_FETCH));

      if(ips.length > 0) {

        let promises = ips.map((ip) => this.processIP(ip));

        await (Promise.all(promises));

        let args = [IP_SET_TO_BE_PROCESSED];
        args.push.apply(args, ips);

        await (rclient.zremAsync(args));

        log.debug(ips.length + "IP Addresses are analyzed with intels");

      } else {
        // log.info("No IP Addresses are pending for intels");
      }

      await (delay(1000)); // sleep for only 1 second

      return this.job();
    })();
  }

  run() {
    sem.on('DestIPFound', (event) => {
      let ip = event.ip;

      // ignore reserved ip address
      if(f.isReservedBlockingIP(ip)) {
        return;
      }

      let fd = event.fd;
      if (fd == null) {
        fd = 'in'
      }

      if(!ip)
        return;

      if(this.paused)
        return;

      if(f.isReservedBlockingIP(ip)) {
        return; // reserved black hole and blue hole...
      }
      
      this.appendNewFlow(ip,fd);
    });

    this.job();

    setInterval(() => {
      this.monitorQueue()
    }, MONITOR_QUEUE_SIZE_INTERVAL)
  }

  monitorQueue() {
    return async(() => {
      let count = await (rclient.zcountAsync(IP_SET_TO_BE_PROCESSED, "-inf", "+inf"));
      if(count > QUEUE_SIZE_PAUSE) {
        this.paused = true;
      }
      if(count < QUEUE_SIZE_RESUME) {
        this.paused = false;
      }
    })();
  }
}

module.exports = DestIPFoundHook;
