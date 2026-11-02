/*    Copyright 2016-2024 Firewalla Inc.
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

const sysManager = require('./SysManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const iptool = require('ip')
const { Address4, Address6 } = require('ip-address')
const _ = require('lodash');

const util = require('util');

const LRU = require('lru-cache');

// rdns TTL refresh throttle: one EXPIRE per key per period; throttled refreshes are deferred
// (not dropped) and flushed by _drainDnsTTL, bounding any TTL-less window to one period.
const RDNS_TTL_REFRESH_PERIOD = 1800 * 1000;

// number of rdns keys read per pipeline when expanding a domain pattern via subdomains2:<suffix>, and number of
// names read and written per batch when migrating legacy sets. pipelineAndLog() wraps a batch in MULTI/EXEC,
// 5000 reads were measured to block redis for 60~85ms on gold
const SUBDOMAIN_BATCH_SIZE = 1000;

// subdomains2:<suffix> is a zset of subdomain names seen under a suffix, score is the last seen timestamp.
// it replaces the legacy subdomains:<suffix> set, which only grew and could reach hundreds of thousands of names.
// a different prefix keeps old and new code from touching each other's key when switching versions
const SUBDOMAIN_KEY_PREFIX = "subdomains2:";
// TTL is only refreshed on write, a suffix nobody writes any more expires by itself
const SUBDOMAIN_KEY_TTL = 86400 * 2;
// keep at most this many names per suffix, the oldest ones are trimmed beyond it
const SUBDOMAIN_MAX_COUNT = 100000;
// the same name under the same suffix is written at most once per this interval
const SUBDOMAIN_WRITE_INTERVAL = 600 * 1000;
// at most one warning per suffix per this interval when a suffix is trimmed
const SUBDOMAIN_TRIM_WARN_INTERVAL = 3600 * 1000;
// legacy subdomains:<suffix> set, migrated into subdomains2:<suffix> once by DataMigrationSensor
const LEGACY_SUBDOMAIN_KEY_PREFIX = "subdomains:";

const firewalla = require('../net2/Firewalla.js');

let instance = null;
const DomainUpdater = require('../control/DomainUpdater.js');
const domainUpdater = new DomainUpdater();

class DNSTool {

  constructor() {
    if (!instance) {
      instance = this;
      if (firewalla.isProduction()) {
        this.debugMode = false;
      } else {
        this.debugMode = true;
      }
      // last EXPIRE time per rdns key, to rate-limit redundant TTL refreshes
      this.dnsExpireTs = new LRU({max: 50000, maxAge: 24 * 3600 * 1000});
      // keys whose TTL refresh was throttled; _drainDnsTTL flushes them within one period
      this.dnsExpirePending = new Map();
      setInterval(() => this._drainDnsTTL(), RDNS_TTL_REFRESH_PERIOD);
      // recently written <suffix>|<name> pairs, to skip redundant subdomains2:<suffix> writes
      this.subDomainWriteTs = new LRU({max: 20000, maxAge: SUBDOMAIN_WRITE_INTERVAL});
      // last trim warning time per suffix
      this.subDomainTrimWarnTs = new LRU({max: 1000, maxAge: SUBDOMAIN_TRIM_WARN_INTERVAL});
    }
    return instance;
  }

  // Returns true if the caller should EXPIRE inline (leading edge). When throttled, defers the
  // refresh into dnsExpirePending so _drainDnsTTL still issues it within one period.
  tryRefreshDnsTTL(key, expr) {
    const now = Date.now();
    const last = this.dnsExpireTs.get(key);
    if (!last || now - last >= RDNS_TTL_REFRESH_PERIOD) {
      this.dnsExpireTs.set(key, now);
      this.dnsExpirePending.delete(key);
      return true;
    }
    this.dnsExpirePending.set(key, expr);
    return false;
  }

  async _drainDnsTTL() {
    if (this.dnsExpirePending.size === 0)
      return;
    const pending = this.dnsExpirePending;
    this.dnsExpirePending = new Map();
    const now = Date.now();
    for (const key of pending.keys()) {
      this.dnsExpireTs.set(key, now);
    }
    if (pending.size === 1) {
      const [key, expr] = pending.entries().next().value;
      await rclient.expireAsync(key, expr).catch((err) => log.error("Failed to flush deferred rdns TTL refreshes", err.message));
    } else {
      const multi = rclient.multi();
      for (const [key, expr] of pending) {
        multi.expire(key, expr);
      }
      await multi.execAsync().catch((err) => log.error("Failed to flush deferred rdns TTL refreshes", err.message));
    }
  }

  getDNSKey(ip) {
    return util.format("rdns:ip:%s", ip);
  }

  getReverseDNSKey(domainName) {
    return `rdns:domain:${domainName}`
  }

  async reverseDNSKeyExists(domain) {
    const type = await rclient.typeAsync(this.getReverseDNSKey(domain))
    return type !== 'none';
  }

  dnsExists(ip) {
    let key = this.getDNSKey(ip);

    return rclient.existsAsync(key)
      .then((exists) => {
        return exists == 1
      })
  }

  async getDns(ip) {
    let key = this.getDNSKey(ip);
    const domain = await rclient.zrevrangeAsync(key, 0, 1); // get domain with latest timestamp
    if (domain && domain.length != 0)
      return domain[0];
    else
      return null;
  }

  async getAllDns(ip) {
    const key = this.getDNSKey(ip);
    const domains = await rclient.zrevrangeAsync(key, 0, -1);
    return domains || [];
  }

  isValidIP(ip) {
    const ip4 = new Address4(ip)
    const ip6 = new Address6(ip)
    if (ip4.isValid() && ip4.correctForm() != '0.0.0.0' || ip6.isValid() && ip6.correctForm() != '::')
      return true
    else
      return false
  }

  async addDns(ip, domain, expire) {
    expire = expire || 24 * 3600; // one day by default
    if (!this.isValidIP(ip))
      return;

    // do not record if *domain* is an IP
    if (this.isValidIP(domain))
      return;

    if (firewalla.isReservedBlockingIP(ip))
      return;
    if (!domain)
      return;

    domain = domain.toLowerCase();
    let key = this.getDNSKey(ip);
    const now = Math.ceil(Date.now() / 1000);
    await rclient.zaddAsync(key, now, domain);
    if (this.tryRefreshDnsTTL(key, expire))
      await rclient.expireAsync(key, expire);
  }

  // doesn't have to keep it long, it's only used for instant blocking

  async addReverseDns(domain, addresses, expire) {
    expire = expire || 24 * 3600; // one day by default
    domain = domain && domain.toLowerCase();
    addresses = addresses || []

    // do not record if *domain* is an IP
    if (this.isValidIP(domain))
      return;

    addresses = addresses.filter((addr) => {
      return addr && firewalla.isReservedBlockingIP(addr) != true
    })

    let key = this.getReverseDNSKey(domain)

    const existing = await this.reverseDNSKeyExists(domain)

    const validAddresses = addresses.filter((addr) => this.isValidIP(addr));
    let updated = false

    if (validAddresses.length > 0) {
      const now = Date.now() / 1000;
      await rclient.zaddAsync(key, _.flatMap(validAddresses, (addr) => [now, addr]))
      updated = true
    }
    domainUpdater.updateDomainMapping(domain, validAddresses);
    const CategoryUpdater = require('../control/CategoryUpdater.js');
    const categoryUpdater = new CategoryUpdater();
    // no need to wait domain pattern update in category
    if (firewalla.isMain())
      categoryUpdater.updateDomainPattern(domain).catch((err) => {
        log.error(`Failed to update category domain pattern on domain ${domain}`, err.message);
      });

    if (updated === false && existing === false) {
      await rclient.zaddAsync(key, new Date() / 1000, firewalla.getRedHoleIP()); // red hole is a placeholder ip for non-existing domain
    }

    if (this.tryRefreshDnsTTL(key, expire))
      await rclient.expireAsync(key, expire)
  }

  getSubDomainKey(domainSuffix) {
    return `${SUBDOMAIN_KEY_PREFIX}${domainSuffix}`;
  }

  // read only: it neither refreshes TTL, otherwise frequent category recycles would keep the key alive forever,
  // nor prunes old names, which OldDataCleanSensor does (see cleanSubdomains). a name not seen for 24 hours has
  // no rdns left in practice, so a stale name kept until the next cleanup contributes no IP.
  // the index is only built by addSubDomains, an empty index means no subdomain has been seen recently.
  // it is never rebuilt by scanning rdns:domain:*, a full keyspace scan blocks redis for long on boxes with
  // many keys, and readers like acl:check may ask for any domain
  async getSubDomains(domainSuffix) {
    return await rclient.zrangeAsync(this.getSubDomainKey(domainSuffix), 0, -1) || [];
  }

  // one-time migration of legacy subdomains:<suffix> sets, called by DataMigrationSensor.
  // only names whose rdns still exists are kept, others have no IP to contribute to pattern expansion
  async migrateLegacySubDomains() {
    const legacyKeys = await rclient.scanResults(`${LEGACY_SUBDOMAIN_KEY_PREFIX}*`);
    for (const legacyKey of legacyKeys) {
      const domainSuffix = legacyKey.substring(LEGACY_SUBDOMAIN_KEY_PREFIX.length);
      await this._migrateLegacySubDomains(legacyKey, domainSuffix).catch((err) => {
        log.error(`Failed to migrate legacy subdomains of ${domainSuffix}`, err.message);
      });
      // legacy key is no longer used, unlink frees a large set in background
      await rclient.unlinkAsync(legacyKey);
    }
  }

  // a legacy set may hold hundreds of thousands of names, it is read and written in batches.
  // names are scored by their last resolve time, so they age out together with their rdns
  async _migrateLegacySubDomains(legacyKey, domainSuffix) {
    let cursor = 0;
    do {
      const [next, domains] = await rclient.sscanAsync(legacyKey, cursor, "COUNT", SUBDOMAIN_BATCH_SIZE);
      cursor = next;
      const resolved = await this._getLastResolveTimes(domains);
      const pairs = [];
      domains.forEach((d, i) => {
        if (resolved[i] > 0)
          pairs.push(resolved[i], d);
      });
      if (pairs.length)
        await this._writeSubDomains(domainSuffix, pairs);
    } while (cursor != 0);
  }

  // last resolve time of each name, i.e. the latest score in rdns:domain:<name>, 0 if the rdns key is gone
  async _getLastResolveTimes(domains) {
    const times = [];
    for (let i = 0; i < domains.length; i += SUBDOMAIN_BATCH_SIZE) {
      const results = await rclient.pipelineAndLog(domains.slice(i, i + SUBDOMAIN_BATCH_SIZE).map(d => ['zrevrange', this.getReverseDNSKey(d), 0, 0, 'WITHSCORES']));
      for (const r of results)
        times.push(Array.isArray(r) && r.length === 2 ? Number(r[1]) : 0);
    }
    return times;
  }

  // called on DNS answers under a registered suffix, see DomainUpdater
  async addSubDomains(domainSuffix, domains) {
    if (_.isEmpty(domains))
      return;
    const toWrite = domains.filter(d => !this.subDomainWriteTs.get(`${domainSuffix}|${d}`));
    if (_.isEmpty(toWrite))
      return;
    const now = Date.now() / 1000;
    await this._writeSubDomains(domainSuffix, _.flatMap(toWrite, d => [now, d]));
    for (const d of toWrite)
      this.subDomainWriteTs.set(`${domainSuffix}|${d}`, 1);
  }

  // pairs: score1, name1, score2, name2, ...
  // ZADD and EXPIRE in one MULTI/EXEC, the index never exists without TTL
  async _writeSubDomains(domainSuffix, pairs) {
    const key = this.getSubDomainKey(domainSuffix);
    const results = await rclient.multi().zadd([key].concat(pairs)).expire(key, SUBDOMAIN_KEY_TTL).zcard(key).execAsync();
    // execAsync only logs errors of queued commands
    const err = (results || []).find(r => r instanceof Error);
    if (err)
      throw err;
    await this._trimSubDomains(domainSuffix, results[2]);
  }

  async _trimSubDomains(domainSuffix, count) {
    if (count > SUBDOMAIN_MAX_COUNT) {
      const key = this.getSubDomainKey(domainSuffix);
      // drop the least recently seen names, keep the SUBDOMAIN_MAX_COUNT most recent ones
      const removed = await rclient.zremrangebyrankAsync(key, 0, -SUBDOMAIN_MAX_COUNT - 1);
      if (removed > 0)
        this._warnTrimSubDomains(domainSuffix, count);
    }
  }

  _warnTrimSubDomains(domainSuffix, count) {
    if (!this.subDomainTrimWarnTs.get(domainSuffix)) {
      this.subDomainTrimWarnTs.set(domainSuffix, 1);
      log.warn(`Too many subdomains under ${domainSuffix}: ${count}, trimmed to ${SUBDOMAIN_MAX_COUNT}`);
    }
  }

  async getIPsByDomain(domain) {
    let key = this.getReverseDNSKey(domain)
    let ips = await rclient.zrangeAsync(key, "0", "-1") || [];
    return ips.filter(ip => !firewalla.isReservedBlockingIP(ip));
  }

  async getIPsByDomainPattern(dnsPattern) {
    const domains = await this.getSubDomains(dnsPattern);

    const keys = domains.map(d => `rdns:domain:${d}`);

    // subdomains set may hold hundreds of thousands of names, read rdns in pipelined batches
    // and dedup with a Set, avoid one round trip per key and O(n^2) dedup
    const ips = new Set();
    for (let i = 0; i < keys.length; i += SUBDOMAIN_BATCH_SIZE) {
      const results = await rclient.pipelineAndLog(keys.slice(i, i + SUBDOMAIN_BATCH_SIZE).map(key => ['zrange', key, 0, -1]));
      for (const l of results) {
        if (!Array.isArray(l)) continue;
        for (const ip of l)
          ips.add(ip);
      }
    }

    return Array.from(ips).filter(ip => !firewalla.isReservedBlockingIP(ip));
  }

  async removeDns(ip, domain) {
    let key = this.getDNSKey(ip);
    // drop throttle state so a later re-add re-issues EXPIRE instead of deferring on a stale ts
    this.dnsExpireTs.del(key);
    this.dnsExpirePending.delete(key);
    await rclient.zremAsync(key, domain);
  }

  async removeReverseDns(domain, ip) {
    let key = this.getReverseDNSKey(domain);
    this.dnsExpireTs.del(key);
    this.dnsExpirePending.delete(key);
    await rclient.zremAsync(key, ip);
  }

  async getLinkedDomains(target, isDomainPattern) {
    isDomainPattern = isDomainPattern || false;
    // target can be either ip or domain
    if (!target)
      return [];
    if (this.isValidIP(target)) {
      // target is ip
      const domains = await this.getAllDns(target);
      return domains || [];
    } else {
      const domains = {}
      let addresses = [];
      if (!isDomainPattern) {
        domains[target] = 1;
        addresses = await this.getIPsByDomain(target);
      } else {
        addresses = await this.getIPsByDomainPattern(target);
      }
      if (addresses && Array.isArray(addresses)) {
        for (const address of addresses) {
          const linkedDomains = await this.getAllDns(address);
          for (const linkedDomain of linkedDomains)
            domains[linkedDomain] = 1;
        }
      }
      return Object.keys(domains);
    }
  }

  async getDefaultDhcpRange(network) {
    let subnet = null;
    if (network === "alternative") {
      subnet = iptool.cidrSubnet(sysManager.mySubnet());
    }
    else if (network === "secondary") {
      const subnet2 = sysManager.mySubnet2() || "192.168.218.1/24";
      subnet = iptool.cidrSubnet(subnet2);
    }
    else if (network === "wifi") {
      const Config = require('./config.js');
      const fConfig = await Config.getConfig(true);
      if (fConfig && fConfig.wifiInterface && fConfig.wifiInterface.iptool)
        subnet = iptool.cidrSubnet(fConfig.wifiInterface.iptool);
    }

    if (!subnet) {
      try {
        // try if network is already a cidr subnet
        subnet = iptool.cidrSubnet(network);
      } catch (err) {
        return null;
      }
    }

    const firstAddr = iptool.toLong(subnet.firstAddress);
    const lastAddr = iptool.toLong(subnet.lastAddress);
    const midAddr = firstAddr + (lastAddr - firstAddr) / 5;
    let rangeBegin = iptool.fromLong(midAddr);
    let rangeEnd = iptool.fromLong(lastAddr - 3);
    return {
      begin: rangeBegin,
      end: rangeEnd
    };
  }

}


module.exports = DNSTool;
