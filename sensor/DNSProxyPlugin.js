/*    Copyright 2021-2022 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const _ = require('lodash');

const validator = require('validator');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const m = require('../extension/metrics/metrics.js');

const flowUtil = require('../net2/FlowUtil');
const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const cc = require('../extension/cloudcache/cloudcache.js');

const fs = require('fs');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js')
const am2 = new AlarmManager2();
const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()
const BF_SERVER_MATCH = "bf_server_match"
const IdentityManager = require('../net2/IdentityManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const extensionManager = require('./ExtensionManager.js')
const tm = require('../alarm/TrustManager.js');

const bf = require('../extension/bf/bf.js');
const LRU = require('lru-cache');

// slices a single byte into bits
// assuming only single bytes
const sliceBits = function (b, off, len) {
  const s = 7 - (off + len - 1);

  b = b >>> s;
  return b & ~(0xff << len);
};

const qnameToDomain = (qname) => {
  let domain = '';
  for (let i = 0; i < qname.length; i++) {
    if (qname[i] == 0) {
      //last char chop trailing .
      domain = domain.substring(0, domain.length - 1);
      break;
    }

    const tmpBuf = qname.slice(i + 1, i + qname[i] + 1);
    domain += tmpBuf.toString('binary', 0, tmpBuf.length);
    domain += '.';

    i = i + qname[i];
  }

  return domain;
};

const defaultExpireTime = 48 * 3600; // expire in two days, by default
const allowKey = "dns_proxy:allow_list"; //unused at this moment
const passthroughKey = "dns_proxy:passthrough_list";
const blockKey = "dns_proxy:block_list";
const featureName = "dns_proxy";
const boneBfKey = "bf:app.intel_bf";

class DNSProxyPlugin extends Sensor {
  constructor(config, bfInfo = { count: 0, error: 0, perfix: "data", level: "strict" }) {
    super(config);
    this.bfInfo = bfInfo;
    this.dnsProxyData = null;
    this.state = false;
    this.processedDomainCache = null;
  }
  async run() {
    // invalidate cache keys when starting up
    await rclient.unlinkAsync(allowKey);
    await rclient.unlinkAsync(blockKey);
    await rclient.unlinkAsync(passthroughKey);
    this.processedDomainCache = new LRU({maxAge: 15000, max: 300});

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyDnsProxy
    });
    this.hookFeature(featureName);
  }

  getFilePath() {
    return `${f.getRuntimeInfoFolder()}/${featureName}.strict_${this.bfInfo.perfix}.bf.data`;
  }

  getDnsmasqConfigFile() {
    return `${dnsmasqConfigFolder}/${featureName}.conf`;
  }

  async enableDnsmasqConfig() {
    log.info("Enabling dnsmasq config file for dnsproxy...");
    if (!this.bfInfo.count || !this.bfInfo.error) {
      log.error("No bloom filter data, skip enabling dnsmasq config");
      return;
    }
    if (this.bfInfo.level !== "strict") {
      log.error("Bloom filter level is not strict, skip enabling dnsmasq config");
      return;
    }

    let dnsmasqEntry = "mac-address-tag=%FF:FF:FF:FF:FF:FF$dns_proxy&1\n";
    const fp = this.getFilePath();
    const entry = `server-bf-exact-uhigh=<${fp},${this.bfInfo.count},${this.bfInfo.error}><${allowKey}><${blockKey}><${passthroughKey}>127.0.0.153#59953$dns_proxy\n`;
    dnsmasqEntry += entry;

    await fs.writeFileAsync(this.getDnsmasqConfigFile(), dnsmasqEntry);
  }

  async disableDnsmasqConfig() {
    log.info("Disabling dnsmasq config file for dnsproxy...");
    await fs.unlinkAsync(this.getDnsmasqConfigFile()).catch(() => undefined); // ignore error
  }

  async applyDnsProxy(host, ip, policy) {
    log.info("Applying dns_proxy", ip, policy);
    if (policy) {
      this.dnsProxyData = policy;
    }
    if (!this.dnsProxyData) {
      this.dnsProxyData = {};
      this.dnsProxyData["default"] = this.config.data;
    }

    if (!this.state) {
      log.info("dns_proxy is disabled, skip applying policy");
      return;
    }

    /* currently, only strict mode is used and only one dns_proxy BF profile 
     * and confirmed no likely to support multiple dns_proxy profiles in the future
     */ 
    const outputFilePath = this.getFilePath();

    if ("strict" in this.dnsProxyData && this.dnsProxyData["strict"]) {
      this.bfInfo.level = "strict";

      await cc.enableCache(boneBfKey, async (jsonString) => {
        if (jsonString) {
          const bloomData = JSON.parse(jsonString);
          if (!bloomData.data || !bloomData.info || !bloomData.info.s || !bloomData.info.e) {
            log.error("Invalid bloom data, skip update bloom filter data.", bloomData);
            return;
          }
          this.bfInfo.count = bloomData.info.s;
          this.bfInfo.error = bloomData.info.e;
          log.info(`dns_proxy bloom filter data loaded, count:${this.bfInfo.count}, error:${this.bfInfo.error}`);

          const need_decompress = false;
          await bf.updateBFData(this.bfInfo, bloomData.data, outputFilePath, need_decompress).catch((err) => {
            log.error("Failed to process data file, err:", err);
          });
          await this.enableDnsmasqConfig().catch((err) => {
            log.error("Failed to enable dnsmasq config, err", err);
          });
        } else {
          log.info(`failed to fetch dns_proxy data from bone with key: ${boneBfKey}, keep original bloom filter data`);
        }
      });

    } else {
      log.info('not strict mode, disable dnsmasq config');
      this.disableDnsmasqConfig();
    }
    // always reschedule dnsmasq restarts when bf data is updated
    dnsmasq.scheduleRestartDNSService();
  }

  async globalOn() {
    this.state = true;
    sclient.subscribe(BF_SERVER_MATCH);
    sclient.on("message", async (channel, message) => {

      switch (channel) {
        case BF_SERVER_MATCH:
          let msgObj;
          try {
            msgObj = JSON.parse(message)
          } catch (err) {
            log.error("parse msg failed", err, message)
          }
          if (msgObj && msgObj.mac) {
            const MAC = msgObj.mac.toUpperCase();
            const ip = msgObj.ip4 || msgObj.ip6;

            // skip category bf match result
            if (msgObj.bf_path.startsWith("/home/pi/.firewalla/run/category_data/filters")) {
              return;
            }
            // do not repeatedly process the same domain in a short time
            if (!this.processedDomainCache.peek(msgObj.domain)) {
              this.processedDomainCache.set(msgObj.domain, true);
              await this.processRequest(msgObj.domain, ip, MAC);
            }
          }

          await m.incr("dns_proxy_request_cnt");
          break;
      }
    });

    sem.on("FastDNSPolicyComplete", async (event) => {
      await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), event.domain);
    });

    await this.applyDnsProxy();
  }

  async globalOff() {
    this.state = false;
    // this channel is also used by CategoryExaminerPlugin.js, unsubscribe here will break functions there
    // sclient.unsubscribe(BF_SERVER_MATCH);

    await cc.disableCache(boneBfKey).catch((err) => {
      log.error("Failed to disable cache, err:", err);
    });

    await this.disableDnsmasqConfig();
    dnsmasq.scheduleRestartDNSService();
  }

  async checkCache(domain) { // only return if there is exact-match intel in redis
    return intelTool.getDomainIntel(domain);
  }

  async _genSecurityAlarm(ip, mac, dn, item) {
    let macEntry;
    let realLocal;
    let guid;
    if (mac) macEntry = await hostTool.getMACEntry(mac);
    if (macEntry) {
      ip = macEntry.ipv4 || macEntry.ipv6 || ip;
    } else {
      const identity = ip && IdentityManager.getIdentityByIP(ip);
      if (identity) {
        guid = IdentityManager.getGUID(identity);
        realLocal = IdentityManager.getEndpointByIP(ip);
      }
      if (!guid) return;
      mac = guid;
    }
    const alarm = new Alarm.IntelAlarm(new Date() / 1000, ip, "major", {
      "p.device.ip": ip,
      "p.dest.name": dn,
      "p.dest.category": "intel",
      "p.security.reason": item.msg,
      "p.device.mac": mac,
      "p.action.block": true,
      "p.blockby": "fastdns",
      "p.local_is_client": "1"
    });
    if (realLocal) {
      alarm["p.device.real.ip"] = realLocal;
    }
    if (guid) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity)
        alarm[identity.constructor.getKeyOfUIDInAlarm()] = identity.getUniqueId();
      alarm["p.device.guid"] = guid;
    }
    await am2.enrichDeviceInfo(alarm);
    am2.enqueueAlarm(alarm); // use enqueue to ensure no dup alarms
  }

  async processRequest(qname, ip, mac) {
    const domain = qname;
    log.info("dns request is", domain);
    const begin = new Date() / 1;
    const cache = await this.checkCache(domain);
    let isIntel = false;
    if (cache) {
      log.info(`inteldns:${domain} is already cached locally, updating redis cache keys directly...`);
      if ((cache.c || cache.category) === "intel") {
        isIntel = true;
        const isTrusted = await tm.matchDomain(domain);

        if(isTrusted) {
          await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), domain);
        } else {
          await this._genSecurityAlarm(ip, mac, domain, cache)
        }

      } else {
        await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), domain);
      }
    } else {
      // if no cache, will trigger cloud inquiry and store the result in cache
      // assume client will send dns query again when cache is ready
      const result = await intelTool.checkIntelFromCloud(undefined, domain); // parameter ip is undefined since it's a dns request only
      isIntel = await this.updateCache(domain, result, ip, mac);
      const end = new Date() / 1;
      log.info("dns intel result is", result, "took", Math.floor(end - begin), "ms");
    }
    await m.incr(isIntel ? "dns_proxy_true_positive" : "dns_proxy_false_positive");
  }

  redisfy(item) {
    for (const k in item) { // to suppress redis error
      const v = item[k];
      if (_.isBoolean(v) || _.isNumber(v) || _.isString(v)) {
        continue;
      }
      item[k] = JSON.stringify(v);
    }
  }

  getSortedItems(items) {
    // sort by length of originIP
    return items.sort((a, b) => {
      const oia = a.originIP;
      const oib = b.originIP;
      if (!oia && !oib) {
        return 0;
      }
      if (oia && !oib) {
        return -1;
      }
      if (!oia && oib) {
        return 1;
      }

      if (oia.length > oib.length) {
        return -1;
      } else if (oia.length < oib.length) {
        return 1;
      }

      return 0;
    });
  }

  async updateCache(domain, result, ip, mac) {
    let isIntel = false;
    if (_.isEmpty(result)) { // empty intel, means the domain is good
      const domains = flowUtil.getSubDomains(domain);
      if (!domains) {
        log.warn("Invalid Domain", domain, "skipped.");
        return false;
      }

      // since result is empty, it means all sub domains of this domain are good
      const placeholder = { c: 'x', a: '1' };
      for (const dn of domains) {
        await intelTool.addDomainIntel(dn, placeholder, defaultExpireTime);
      }

      // only the exact dn is added to the passthrough and block list
      // generic domains can't be added, because another sub domain may be malicous
      // example:
      //   domain1.blogspot.com may be good
      //   and domain2.blogspot.com may be malicous
      // when domain1 is checked to be good, we should NOT add blogspot.com to passthrough_list
      await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), domain);

    } else {
      // sort by length of originIP
      const validItems = result.filter((item) => item.originIP && validator.isFQDN(item.originIP));
      const sortedItems = this.getSortedItems(validItems);

      if (_.isEmpty(sortedItems)) {
        return false;
      }

      for (const item of sortedItems) {
        this.redisfy(item);
        const dn = item.originIP; // originIP is the domain
        await intelTool.addDomainIntel(dn, item, item.e || defaultExpireTime);
        if (item.c !== "intel") {
          await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), domain);
        }
      }

      for (const item of sortedItems) {
        if (item.c === "intel") {
          isIntel = true;
          const dn = item.originIP; // originIP is the domain
          await this._genSecurityAlarm(ip, mac, dn, item);
          break;
        }
      }
    }
    return isIntel;
  }

}

module.exports = DNSProxyPlugin;
