/*    Copyright 2016-2020 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename, 'info');

const Hook = require('./Hook.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

const f = require("../net2/Firewalla.js")

const Promise = require('bluebird');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()
const CountryUpdater = require('../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

const country = require('../extension/country/country.js');
const sysManager = require('../net2/SysManager.js')

const IP_SET_TO_BE_PROCESSED = "ip_set_to_be_processed";

const ITEMS_PER_FETCH = 100;
const QUEUE_SIZE_PAUSE = 2000;
const QUEUE_SIZE_RESUME = 1000;

const TRUST_THRESHOLD = 10 // to be updated

const MONITOR_QUEUE_SIZE_INTERVAL = 10 * 1000; // 10 seconds;
const {isSimilarHost} = require('../util/util');
class DestIPFoundHook extends Hook {

  constructor() {
    super();

    this.config.intelExpireTime = 2 * 24 * 3600; // two days
    this.pendingIPs = {};
  }

  appendNewIP(ip) {
    log.debug("Enqueue new ip for intels", ip);
    return rclient.zaddAsync(IP_SET_TO_BE_PROCESSED, 0, ip);
  }

  appendNewFlow(ip, fd, retryCount) {
    let flow = {
       ip:ip,
       fd:fd,
       retryCount: retryCount || 0
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

  // TBD
  // select the best fit intel from intel results from cloud

  selectIntel(intels) {

  }

  aggregateIntelResult(ip, sslInfo, dnsInfo, cloudIntelInfos) {
    let intel = {
      ip: ip
    };

    // sslInfo is an object, dnsInfo is a string
    if(dnsInfo) {
      intel.host = dnsInfo;
      intel.dnsHost = dnsInfo;
    }

    if(sslInfo && sslInfo.server_name) {
      intel.host = sslInfo.server_name
      intel.sslHost = sslInfo.server_name
      intel.org = sslInfo.O
    }

    // app
    cloudIntelInfos.forEach((info) => {

      if (info.failed) {
        intel.cloudFailed = true;
      }

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
      if(info.app) {
        intel.apps = info.app; // json string format
        try {
          const apps = JSON.parse(intel.apps)
          const keys = Object.keys(apps);
          if(keys && keys[0]) {
            intel.app = keys[0];
          }
        } catch(err) {
          log.error("Failed to parse app json, err:", err);
        }
      }

      // always try to use the general domain pattern with same category
      // a.b.c.d => porn
      // b.c.d => porn
      // c.d => search engine
      //
      // 'b.c.d => porn' should be used

      if(info.c) {
        if(intel.category && info.c === intel.category) { // ignore if they are same category
          return
        }
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

      if(info.cc) {
        intel.cc = info.cc;
      }

      if(info.cs) {
        intel.cs = info.cs;
      }

      if(info.v) {
        intel.v = info.v;
      }

      if(info.originIP) {
        intel.originIP = info.originIP
      }
      //      }
    });

    const domains = this.getDomains(sslInfo, dnsInfo);

    if(intel.originIP && !domains.includes(intel.originIP)) {
      // it's a pattern
      intel.isOriginIPAPattern = true
    }

    return intel;
  }

  getDomains(sslInfo, dnsInfo) {
    // sslInfo is an object, dnsInfo is a string
    let domain = sslInfo && sslInfo.server_name;
    if(!domain) {
      domain = dnsInfo;
    }

    let domains = [];
    if(domain)
      domains.push(domain);

    return domains;
  }

  async updateCategoryDomain(intel) {
    if(intel.host && intel.category && intel.t > TRUST_THRESHOLD) {
      if(intel.originIP) {
        await categoryUpdater.updateDomain(intel.category, intel.originIP, intel.isOriginIPAPattern)
      } else {
        await categoryUpdater.updateDomain(intel.category, intel.host)
      }
    }
  }

  async updateCountryIP(intel) {
    if(intel.ip && intel.country) {
      await countryUpdater.updateIP(intel.country, intel.ip)
    }
  }

  async processIP(flow, options) {
    let ip = null;
    let fd = 'in';
    let retryCount = 0;

    if (flow) {
      let parsed = null;
      try {
        parsed = JSON.parse(flow);
        if (parsed.fd) {
          fd = parsed.fd;
          ip = parsed.ip;
          retryCount = parsed.retryCount || 0;
        } else {
          ip = flow;
          fd = 'in';
        }
      } catch(e) {
        ip = flow;
      }
    }
    options = options || {};

    if (sysManager.isLocalIP(ip)) {
      return
    }

    const skipReadLocalCache = options.skipReadLocalCache;
    const skipWriteLocalCache = options.skipWriteLocalCache;
    let sslInfo = await intelTool.getSSLCertificate(ip);
    let dnsInfo = await intelTool.getDNS(ip);
    let domains = this.getDomains(sslInfo, dnsInfo); // domains should contain at most one domain
    if (domains.length == 0 && retryCount < 5) {
      // domain is not fetched from either dns or ssl entries, retry in next job() schedule
      this.appendNewFlow(ip, fd, retryCount + 1);
    }

    try {
      let intel;
      if (!skipReadLocalCache) {
        intel = await intelTool.getIntel(ip);

        if (intel && !intel.cloudFailed) {
          // use cache data if host is similar or ssl org is identical (relatively loose condition to avoid calling intel API too frequently)
          if (domains.length == 0 || (sslInfo && intel.org && sslInfo.O === intel.org) || (intel.host && isSimilarHost(domains[0], intel.host))) {
            await this.updateCategoryDomain(intel);
            await this.updateCountryIP(intel);
            return;
          }
        }
      }

      log.debug("Found new IP " + ip + " fd " +fd+ " flow "+flow+ " domain " + domains + ", checking intels...");

      let ips = [ip];

      let cloudIntelInfo = [];

      // ignore if domain contain firewalla domain
      if(domains.filter(d => this.isFirewalla(d)).length === 0) {
        try {
          cloudIntelInfo = await intelTool.checkIntelFromCloud(ips, domains, fd);
        } catch(err) {
          // marks failure while not blocking local enrichement, e.g. country
          cloudIntelInfo.push({failed: true});

          if(options.noUpdateOnError) {
            return null;
          }
        }
      }

      // Update intel rdns:ip:xxx.xxx.xxx.xxx so that legacy can use it for better performance
      let aggrIntelInfo = this.aggregateIntelResult(ip, sslInfo, dnsInfo, cloudIntelInfo);
      aggrIntelInfo.country = aggrIntelInfo.country || country.getCountry(ip) || ""; // empty string for unidentified country

      // update category pool if necessary
      await this.updateCategoryDomain(aggrIntelInfo);
      await this.updateCountryIP(aggrIntelInfo);

      const oldIntel = await intelTool.getIntel(ip);
      // when ip category changed should update old category ipset
      // it is no pure category ip
      if (oldIntel && oldIntel.category && oldIntel.category != aggrIntelInfo.category) {
        const pureCategoryIps = await rclient.smembersAsync(`rdns:category:${oldIntel.category}`);
        if (pureCategoryIps && pureCategoryIps.includes(ip)) {
          sem.emitEvent({
            type: "UPDATE_CATEGORY_DOMAIN",
            category: oldIntel.category,
            toProcess: "FireMain"
          });
        }
      }

      // only set default action when cloud succeeded
      if(!aggrIntelInfo.action &&
        aggrIntelInfo.category !== 'intel' && // a special workaround here, only reset action when category is no longer intel
        !aggrIntelInfo.cloudFailed &&
        skipReadLocalCache
      ) {
        if(oldIntel.category === 'intel') {
          log.info("Reset local intel action since it's not intel categary anymore.");
          aggrIntelInfo.action = "none";
        }
      }

      if(!skipWriteLocalCache) {
        // remove intel in case some keys in old intel hash is not updated if number of keys in new intel is less than that in old intel
        await intelTool.removeIntel(ip);
        await intelTool.addIntel(ip, aggrIntelInfo, this.config.intelExpireTime);
      }

      return aggrIntelInfo;

    } catch(err) {
      log.error(`Failed to process IP ${ip}, error:`, err);
      return null;
    }
  }

  async job() {
    log.debug("Checking if any IP Addresses pending for intel analysis...")

    try {
      let ips = await rclient.zrangeAsync(IP_SET_TO_BE_PROCESSED, 0, ITEMS_PER_FETCH);

      if(ips.length > 0) {
        let promises = ips.map((ip) => this.processIP(ip));

        await Promise.all(promises)

        let args = [IP_SET_TO_BE_PROCESSED];
        args.push.apply(args, ips);

        await rclient.zremAsync(args)

        log.debug(ips.length + "IP Addresses are analyzed with intels");

      } else {
        // log.info("No IP Addresses are pending for intels");
      }
    } catch(err) {
      log.error("Got error when handling new dest IP addresses, err:", err)
    }

    setTimeout(() => {
      this.job(); // sleep for only 500 mill-seconds
    }, 500);
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

      this.appendNewFlow(ip, fd);
    });

    sem.on('DestIP', (event) => {
      const skipReadLocalCache = event.skipReadLocalCache;
      const noUpdateOnError = event.noUpdateOnError;
      this.processIP(event.ip, {skipReadLocalCache, noUpdateOnError});
    })

    this.job();

    setInterval(() => {
      this.monitorQueue()
    }, MONITOR_QUEUE_SIZE_INTERVAL)
  }

  async monitorQueue() {
    let count = await rclient.zcountAsync(IP_SET_TO_BE_PROCESSED, "-inf", "+inf")
    if(count > QUEUE_SIZE_PAUSE) {
      this.paused = true;
    }
    if(count < QUEUE_SIZE_RESUME) {
      this.paused = false;
    }
  }
}

module.exports = DestIPFoundHook;
