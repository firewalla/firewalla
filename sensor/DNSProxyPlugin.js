/*    Copyright 2021 Firewalla LLC
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
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();

const alreadyAppliedFlag = "default_c_init_done";
const policyTarget = "default_c";
const policyType = "category";

const sys = require('sys'),
  Buffer = require('buffer').Buffer,
  dgram = require('dgram');

const bf = require('../extension/bf/bf.js');

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

class DNSProxyPlugin extends Sensor {
  async run() {
    // invalidate cache keys when starting up
    await rclient.delAsync(allowKey);
    await rclient.delAsync(blockKey);
    await rclient.delAsync(passthroughKey);

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyDnsProxy
    });
    this.hookFeature(featureName);
  }

  getHashKeyName(item = {}, level = "default") {
    if (!item.count || !item.error || !item.prefix) {
      log.error("Invalid item:", item);
      return null;
    }

    const { count, error, prefix } = item;

    if (level) {
      return `bf:${level}_${prefix}:${count}:${error}`;
    }
    return `bf:${prefix}:${count}:${error}`;
  }

  getFilePath(item = {}) {
    if (!item.count || !item.error || !item.prefix) {
      log.error("Invalid item:", item);
      return null;
    }

    const { count, error, prefix, level } = item;

    if (level) {
      return `${f.getRuntimeInfoFolder()}/${featureName}.${level}_${prefix}.bf.data`;
    }
    return `${f.getRuntimeInfoFolder()}/${featureName}.${prefix}.bf.data`;
  }

  getDnsmasqConfigFile() {
    return `${dnsmasqConfigFolder}/${featureName}.conf`;
  }

  async enableDnsmasqConfig(data) {
    log.info("Enabling dnsmasq config file for dnsproxy...");
    let dnsmasqEntry = "mac-address-tag=%FF:FF:FF:FF:FF:FF$dns_proxy&1\n";
    for (const level in data) {
      const levelData = data[level];
      for (const item of levelData) {
        item.level = level;
        const fp = this.getFilePath(item);
        if (!fp) {
          continue;
        }
        const entry = `server-bf-high=<${fp},${item.count},${item.error}><${allowKey}><${blockKey}><${passthroughKey}>127.0.0.153#59953$dns_proxy\n`;
        dnsmasqEntry += entry;
      }
    }

    await fs.writeFileAsync(this.getDnsmasqConfigFile(), dnsmasqEntry);
    await dnsmasq.scheduleRestartDNSService();
  }

  async disableDnsmasqConfig() {
    log.info("Disabling dnsmasq config file for dnsproxy...");
    await fs.unlinkAsync(this.getDnsmasqConfigFile()).catch(() => undefined); // ignore error
    await dnsmasq.scheduleRestartDNSService();
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
      log.info("dns_proxy feature is disabled, skip applying policy");
      return;
    }

    // level: strict, default... usually just one level at the same time, but the code supports multiple anyway
    for (const level in this.dnsProxyData) {
      const levelData = this.dnsProxyData[level];
      // item: data, new... each one is a bloom data
      for (const item of levelData) {
        item.level = level;
        const hashKeyName = bf.getHashKeyName(item);
        if (!hashKeyName) continue;

        log.info("Processing data file:", hashKeyName);
        const outputFilePath = this.getFilePath(item);
        await cc.enableCache(hashKeyName, async (data) => {
          await bf.updateBFData(item, data, outputFilePath).catch((err) => {
            log.error("Failed to process data file, err:", err);
          });

          // always reschedule dnsmasq restarts when bf data is updated
          await dnsmasq.scheduleRestartDNSService();
        });
      }
    }

    await this.enableDnsmasqConfig(this.dnsProxyData).catch((err) => {
      log.error("Failed to enable dnsmasq config, err", err);
    });
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

            await this.processRequest(msgObj.domain, ip, MAC);
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

    sclient.unsubscribe(BF_SERVER_MATCH);

    if (!_.isEmpty(this.dnsProxyData)) {
      for (const level in this.dnsProxyData) {
        const levelData = this.dnsProxyData[level];
        for (const item of levelData) {
          item.level = level;
          const hashKeyName = this.getHashKeyName(item);
          if (!hashKeyName) continue;
          await cc.disableCache(hashKeyName).catch((err) => {
            log.error("Failed to disable cache, err:", err);
          });
        }
      }
    }

    await this.disableDnsmasqConfig();
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
    if (cache) {
      log.info(`inteldns:${domain} is already cached locally, updating redis cache keys directly...`);
      if (cache.c === "intel") {
        await this._genSecurityAlarm(ip, mac, domain, cache)
      } else {
        await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), domain);
      }
      return; // do need to do anything
    }
    const result = await intelTool.checkIntelFromCloud(undefined, domain); // parameter ip is undefined since it's a dns request only
    await this.updateCache(domain, result, ip, mac);
    const end = new Date() / 1;
    log.info("dns intel result is", result, "took", Math.floor(end - begin), "ms");
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
    if (_.isEmpty(result)) { // empty intel, means the domain is good
      const domains = flowUtil.getSubDomains(domain);
      if (!domains) {
        log.warn("Invalid Domain", domain, "skipped.");
        return;
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
        return;
      }

      for (const item of sortedItems) {
        this.redisfy(item);
        const dn = item.originIP; // originIP is the domain
        await intelTool.addDomainIntel(dn, item, item.e || defaultExpireTime);
        if (item.c !== "intel") {
          await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), dn);
        }
      }

      for (const item of sortedItems) {
        if (item.c === "intel") {
          const dn = item.originIP; // originIP is the domain
          await this._genSecurityAlarm(ip, mac, dn, item);
          break;
        }
      }
    }
  }

}

module.exports = DNSProxyPlugin;
