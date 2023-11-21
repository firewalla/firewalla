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

const log = require('../net2/logger.js')(__filename, 'info');

const Hook = require('./Hook.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

const f = require("../net2/Firewalla.js");
const fc = require('../net2/config.js');

const Promise = require('bluebird');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const sl = require('../sensor/SensorLoader.js');

const m = require('../extension/metrics/metrics.js');

const rp = require('request-promise');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()
const CountryUpdater = require('../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

const country = require('../extension/country/country.js');

const _ = require('lodash')

const IP_SET_TO_BE_PROCESSED = "ip_set_to_be_processed";

const ITEMS_PER_FETCH = 100;
const QUEUE_SIZE_PAUSE = 2000;
const QUEUE_SIZE_RESUME = 1000;

const TRUST_THRESHOLD = 10 // to be updated

const MONITOR_QUEUE_SIZE_INTERVAL = 10 * 1000; // 10 seconds;
const { isSimilarHost } = require('../util/util');
const flowUtil = require('../net2/FlowUtil');
const validator = require('validator');
const iptool = require('ip');
const Message = require('../net2/Message.js');

const fastIntelFeature = "fast_intel";
const LRU = require('lru-cache');

class DestIPFoundHook extends Hook {

  constructor() {
    super();
    this.pendingIPs = {};
    this.triggerCache = new LRU({
      max: 1000,
      maxAge: 1000 * 60 * 5
    });
  }

  appendNewIP(ip) {
    log.debug("Enqueue new ip for intels", ip);
    return rclient.zaddAsync(IP_SET_TO_BE_PROCESSED, 0, ip);
  }

  appendNewFlow(flow) {
    if (!flow.retryCount)
      flow.retryCount = 0;
    return rclient.zaddAsync(IP_SET_TO_BE_PROCESSED, 0, JSON.stringify(flow));
  }

  isFirewalla(host) {
    if (!_.isString(host)) return false

    let patterns = [/\.encipher\.io$/,
      /^encipher\.io$/,
      /^firewalla\.com$/,
      /\.firewalla\.com$/];

    return patterns.filter(p => host.match(p)).length > 0;
  }

  aggregateIntelResult(ip, host, sslInfo, dnsInfo, intelSources) {
    let intel = {
      ip: ip
    };

    // sslInfo is an object, dnsInfo is a string
    if (dnsInfo) {
      intel.host = dnsInfo;
      intel.dnsHost = dnsInfo;
    }

    if (sslInfo) {
      if (sslInfo.server_name) {
        intel.host = sslInfo.server_name
        intel.sslHost = sslInfo.server_name
      }
      if (sslInfo.org)
        intel.org = sslInfo.O
    }

    if (host)
      intel.host = host;

    log.debug('sources', intelSources)
    intelSources.forEach((info) => {

      if (info.failed) {
        intel.cloudFailed = true;
      }

      // https://github.com/firewalla/firewalla/commit/726b56cd736e6916ac335b1e4c826a81c9718724
      // could be plain string or json string, e.g.
      // app: '{"youtube":1}'
      const appString = info.app || info.apps
      if (_.isString(info.app))
        if (appString.startsWith('{')) {
          try {
            const apps = JSON.parse(appString)
            const keys = Object.keys(apps);
            if (keys && keys[0]) {
              intel.app = keys[0];
            }
          } catch (err) {
            log.error("Failed to parse app json, err:", err, intel);
          }
        } else {
          intel.app = appString
        }

      // always try to use the general domain pattern with same category
      // a.b.c.d => porn
      // b.c.d => porn
      // c.d => search engine
      //
      // 'b.c.d => porn' should be used

      // FIXME: no proper ordering here, this results in random overwrite
      if (info.c) {
        if (intel.category && info.c === intel.category) { // ignore if they are same category
          return
        }
        intel.category = info.c;
      }

      if (info.action && info.action.block) {
        intel.action = "block"
      }

      Object.assign(intel, _.pick(info, ['s', 't', 'cc', 'cs', 'v', 'a', 'originIP', 'msg', 'reference', 'e', 'country', 'category']))
    });

    const domain = this.getDomain(sslInfo, dnsInfo);

    if (intel.originIP && domain != intel.originIP && ip != intel.originIP) {
      // it's a pattern
      intel.isOriginIPAPattern = true
    }

    if (intel.originIP && ip === intel.originIP) {
      intel.isOriginIPIP = true
    }

    return intel;
  }

  getDomain(sslInfo, dnsInfo) {
    // sslInfo is an object, dnsInfo is a string
    return sslInfo && sslInfo.server_name || dnsInfo;
  }

  async updateCategoryDomain(intel) {
    if (intel.host && intel.category && intel.t > TRUST_THRESHOLD) {
      if (intel.originIP) {
        await categoryUpdater.updateDomain(intel.category, intel.originIP, intel.isOriginIPAPattern)
      } else {
        await categoryUpdater.updateDomain(intel.category, intel.host)
      }
    }
  }

  async updateCountryIP(intel) {
    if (intel.ip && intel.country) {
      await countryUpdater.updateIP(intel.country, intel.ip)
    }
  }

  async updateDomainCache(intelInfos) {
    if (!intelInfos) return;
    for (const item of intelInfos) {
      // originIP is the matching domain of cloud intel, so this won't create a huge memory overhead
      const dn = item.originIP
      const isDomain = validator.isFQDN(dn);
      if (!isDomain) {
        continue;
      }
      for (const k in item) {
        const v = item[k];
        if (_.isBoolean(v) || _.isNumber(v) || _.isString(v)) {
          continue;
        }
        item[k] = JSON.stringify(v);
      }
      await intelTool.addDomainIntel(dn, item, item.e);
    }
  }

  async getCacheIntelDomain(domain) {
    const result = [];
    const domains = flowUtil.getSubDomains(domain) || [];
    for (const d of domains) {
      const domainIntel = await intelTool.getDomainIntel(d);
      if (domainIntel) result.push(domainIntel)
    }
    return result;
  }

  async loadIntel(ip, domain, fd) {
    try {
      const fip = sl.getSensor("FastIntelPlugin");
      if (!fip || !fc.isFeatureOn(fastIntelFeature) || !fip.isWorking()) { // no plugin found
        return await intelTool.checkIntelFromCloud(ip, domain, { fd });
      }

      const domains = flowUtil.getSubDomains(domain) || [];
      const query = (ip ? [ip, ...domains] : domains).join(",");

      const baseURL = fip.getIntelProxyBaseUrl();

      const options = {
        uri: `${baseURL}/check`,
        qs: { d: query },
        family: 4,
        method: "GET",
        json: true
      };

      const rpResult = await rp(options).catch((err) => {
        log.error("got error when calling intel proxy, err:", err.message, "d:", query);
        return { result: true };
      });

      const matched = rpResult && rpResult.result; // { "result": true }

      const maxLucky = (this.config && this.config.maxLucky) || 50;

      // lucky is only used when unmatched
      const lucky = !matched && (Math.floor(Math.random() * maxLucky) === 1);

      if (lucky) {
        log.info(`Lucky! Going to check ${query} in cloud`);
      }

      // use lucky to randomly send domains to cloud
      if (matched || lucky) { // need to check cloud
        await m.incr("fast_intel_positive_cnt");
        return await intelTool.checkIntelFromCloud(ip, domain, { fd, lucky });
      } else { // safe, just return empty array
        await m.incr("fast_intel_negative_cnt");
        return [];
      }

    } catch (err) {
      log.error("Failed to load intel, err:", err);
      return [];
    }
  }

  async processIP(flow, options) {
    let enrichedFlow = {};
    let requeued = false;
    if (flow) {
      let parsed = null;
      try {
        parsed = JSON.parse(flow);
        enrichedFlow = Object.assign(enrichedFlow, parsed);
        enrichedFlow.retryCount = parsed.retryCount || 0;
        enrichedFlow.fd = parsed.fd || "in";
      } catch (e) {
        // base IP address as argument
        enrichedFlow.ip = flow;
        enrichedFlow.fd = "in";
        enrichedFlow.retryCount = 0;
      }
    }
    if (_.isEmpty(enrichedFlow))
      return;
    
    let {ip, fd, host, mac, retryCount} = enrichedFlow;
    options = options || {};

    try {
      if (iptool.isPrivate(ip)) {
        return
      }

      const skipReadLocalCache = options.skipReadLocalCache;
      const skipWriteLocalCache = options.skipWriteLocalCache;
      let sslInfo = await intelTool.getSSLCertificate(ip);
      let dnsInfo = await intelTool.getDNS(ip);
      let domain = host || this.getDomain(sslInfo, dnsInfo);
      if (!domain && retryCount < 5) {
        enrichedFlow.retryCount++;
        // domain is not fetched from either dns or ssl entries, retry in next job() schedule
        this.appendNewFlow(enrichedFlow);
        requeued = true;
      }

      // Update category filter set
      if (domain) {
        const event = {
          type: "DOMAIN_DETECTED",
          domain: domain,
          suppressEventLogging: true
        };
        sem.emitLocalEvent(event);
      }
    
      let intel;
      if (!skipReadLocalCache) {
        intel = await intelTool.getIntel(ip);

        if (intel && !intel.cloudFailed) {
          // use cache data if host is similar or ssl org is identical
          // (relatively loose condition to avoid calling intel API too frequently)
          if (!domain
            || sslInfo && intel.org && sslInfo.O === intel.org
            || intel.host && isSimilarHost(domain, intel.host)
          ) {
            await this.updateCategoryDomain(intel);
            await this.updateCountryIP(intel);
            if (intel.category === "intel")
              this.shouldTriggerDetectionImmediately(mac);
            log.debug('return cached intel:', intel)
            if (enrichedFlow)
              enrichedFlow.intel = intel;
            return intel;
          }
        }
      }

      log.debug(`Found new IP:${ip} fd:${fd} flow:${flow} domain:${domain}, checking intels...`);

      let intelSources = [];

      // ignore if domain contain firewalla domain
      if (!this.isFirewalla(domain)) {
        try {
          const result = (await intelTool.getDomainIntelAll(domain)).filter(intel => intel.ts || intel.hash); // CategoryUpdater may directly add inteldns entries with only 'c' field, other fields from cloud are missing, e.g, app, hash, need to sync from cloud
          if (result.length != 0) {
            log.debug('cached domain intel:', result)
            intelSources = result.reverse();
          } else {
            intelSources = await this.loadIntel(ip, domain, fd);
            log.debug('got cloud intel:', intelSources)
            await this.updateDomainCache(intelSources);
          }
          // custom intel has higher priority as appeneded later in the array
          const cDomainIntel = await intelTool.getDomainIntelAll(domain, true);
          cDomainIntel.length && log.debug('append custom domain intel:', cDomainIntel)
          while (cDomainIntel.length) intelSources.push(cDomainIntel.pop())
        } catch (err) {
          // marks failure while not blocking local enrichement, e.g. country
          log.debug("Failed to get cloud intel", ip, domain, err)
          intelSources.push({ failed: true });

          if (options.noUpdateOnError) {
            return null;
          }
        }
      }

      const cIpIntel = await intelTool.getCustomIntel('ip', ip)
      if (cIpIntel) {
        log.debug('append custom ip intel:', cIpIntel)
        intelSources.push(cIpIntel)
      }

      // Update intel rdns:ip:xxx.xxx.xxx.xxx so that legacy can use it for better performance
      let aggrIntelInfo = this.aggregateIntelResult(ip, domain, sslInfo, dnsInfo, intelSources);
      aggrIntelInfo.country = aggrIntelInfo.country || country.getCountry(ip) || ""; // empty string for unidentified country

      for (const key in aggrIntelInfo) {
        // NONE is a reseved word for custom intel to state a specific field to be empty
        if (aggrIntelInfo[key] == 'NONE') delete aggrIntelInfo[key]
      }


      // update category pool if necessary
      await this.updateCategoryDomain(aggrIntelInfo);
      await this.updateCountryIP(aggrIntelInfo);

      if (skipReadLocalCache) {
        intel = await intelTool.getIntel(ip);

        if (!aggrIntelInfo.action &&
          aggrIntelInfo.category !== 'intel' && // only reset action when category is no longer intel
          !aggrIntelInfo.cloudFailed &&
          intel && intel.category === 'intel'
        ) {
          log.info("Reset local intel action since it's not intel categary anymore.");
          aggrIntelInfo.action = "none";
        }
      }

      if (!skipWriteLocalCache) {
        // remove intel in case some keys in old intel doesn't exist in new one
        await intelTool.removeIntel(ip);
        await intelTool.addIntel(ip, aggrIntelInfo);
      }

      // check if detection should be triggered on this flow/mac immediately to speed up detection
      if(aggrIntelInfo.category === 'intel') {
        this.shouldTriggerDetectionImmediately(mac);
      }

      if (enrichedFlow)
        enrichedFlow.intel = aggrIntelInfo;
      log.debug('result intel:', aggrIntelInfo)
      return aggrIntelInfo;

    } catch (err) {
      log.error(`Failed to process IP ${ip}, error:`, err);
      return null;
    } finally {
      if (enrichedFlow && enrichedFlow.from === "flow" && !requeued) {
        sem.emitLocalEvent({
          type: Message.MSG_FLOW_ENRICHED,
          suppressEventLogging: true,
          flow: enrichedFlow
        });
      }
    }
  }

  shouldTriggerDetectionImmediately(mac) {
    if (!mac)
      return;
    if(this.triggerCache.get(mac) !== undefined) {
      // skip if duplicate in 5 minutes
      return;
    }

    this.triggerCache.set(mac, 1);

    log.info("Triggering FW_DETECT_REQUEST on mac", mac);

    // trigger firemon detect immediately to detect the malware activity sooner
    sem.sendEventToFireMon({
      type: 'FW_DETECT_REQUEST',
      mac
    });
  }

  async job() {
    log.silly("Checking if any IP Addresses pending for intel analysis...")

    try {
      let ips = await rclient.zrangeAsync(IP_SET_TO_BE_PROCESSED, 0, ITEMS_PER_FETCH);

      if (ips.length > 0) {
        let promises = ips.map((ip) => this.processIP(ip));

        await Promise.all(promises)

        let args = [IP_SET_TO_BE_PROCESSED];
        args.push.apply(args, ips);

        await rclient.zremAsync(args)

        log.silly(ips.length + " IP Addresses are analyzed with intels");

      } else {
        // log.info("No IP Addresses are pending for intels");
      }
    } catch (err) {
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
      if (f.isReservedBlockingIP(ip)) {
        return;
      }

      let fd = event.fd;
      if (fd == null) {
        fd = 'in'
      }

      if (!ip)
        return;

      if (this.paused)
        return;

      const flow = event.flow || _.pick(event, ["mac", "ip", "host", "fd"]);
      if (event.from)
        flow.from = event.from;
      this.appendNewFlow(flow);
    });

    sem.on('DestIP', (event) => {
      const skipReadLocalCache = event.skipReadLocalCache;
      const noUpdateOnError = event.noUpdateOnError;
      this.processIP(event.ip, { skipReadLocalCache, noUpdateOnError });
    })

    this.job();

    setInterval(() => {
      this.monitorQueue()
    }, MONITOR_QUEUE_SIZE_INTERVAL)
  }

  async monitorQueue() {
    let count = await rclient.zcountAsync(IP_SET_TO_BE_PROCESSED, "-inf", "+inf")
    if (count > QUEUE_SIZE_PAUSE) {
      this.paused = true;
    }
    if (count < QUEUE_SIZE_RESUME) {
      this.paused = false;
    }
  }
}

module.exports = DestIPFoundHook;
