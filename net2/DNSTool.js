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
const MAX_DNS_EXPIRE_PENDING = 50000;

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
      this.dnsExpireTs = new LRU({max: MAX_DNS_EXPIRE_PENDING, maxAge: 24 * 3600 * 1000});
      // keys whose TTL refresh was throttled; _drainDnsTTL flushes them within one period
      this.dnsExpirePending = new Map();
      // A failed drain is retried before newer pending refreshes. This is bounded to one batch.
      this.dnsExpireRetry = new Map();
      this.dnsExpireActive = null;
      this.dnsExpireActiveUpdates = new Map();
      this.dnsExpireDrainPromise = null;
      // Suppress overflow inline refreshes globally until the queue has capacity again or the
      // throttle period expires. A per-key map could evict suppression markers under high cardinality.
      this.dnsExpireOverflowTs = 0;
      // Number of unique refreshes handled inline because the deferred queue was full.
      // Logged and reset once per drain period to avoid one warning per incoming update.
      this.dnsExpireOverflowCount = 0;
      this.dnsExpireTimer = setInterval(() => this._drainDnsTTL(), RDNS_TTL_REFRESH_PERIOD);
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
      this.dnsExpireRetry.delete(key);
      if (this.dnsExpireActive && this.dnsExpireActive.has(key)) {
        this.dnsExpireActiveUpdates.set(key, expr);
        return false;
      }
      return true;
    }
    if (this.dnsExpireOverflowTs && now - this.dnsExpireOverflowTs < RDNS_TTL_REFRESH_PERIOD) {
      if (this.dnsExpirePending.has(key)) {
        this.dnsExpirePending.set(key, expr);
        return false;
      }
      if (this.dnsExpirePending.size < MAX_DNS_EXPIRE_PENDING) {
        this.dnsExpireOverflowTs = 0;
        this.dnsExpirePending.set(key, expr);
      } else {
        if (this.dnsExpireActive && this.dnsExpireActive.has(key)) {
          this.dnsExpireActiveUpdates.set(key, expr);
          return false;
        }
        const drainActive = !!this.dnsExpireDrainPromise;
        this._drainDnsTTL();
        if (drainActive) {
          this.dnsExpireOverflowTs = now;
          this.dnsExpireTs.set(key, now);
          if (this.dnsExpireActiveUpdates.size < MAX_DNS_EXPIRE_PENDING)
            this.dnsExpireActiveUpdates.set(key, expr);
          return false;
        }
        this.dnsExpirePending.set(key, expr);
      }
      return false;
    }
    if (!this.dnsExpirePending.has(key) && this.dnsExpirePending.size >= MAX_DNS_EXPIRE_PENDING) {
      if (this.dnsExpireActive && this.dnsExpireActive.has(key)) {
        this.dnsExpireActiveUpdates.set(key, expr);
        return false;
      }
      if (this.dnsExpireDrainPromise) {
        this.dnsExpireOverflowTs = now;
        this.dnsExpireTs.set(key, now);
        if (this.dnsExpireActiveUpdates.size < MAX_DNS_EXPIRE_PENDING)
          this.dnsExpireActiveUpdates.set(key, expr);
        return false;
      }
      this.dnsExpireOverflowCount++;
      this.dnsExpireOverflowTs = now;
      this.dnsExpireTs.set(key, now);
      return true;
    }
    this.dnsExpirePending.set(key, expr);
    return false;
  }

  _drainDnsTTL() {
    if (this.dnsExpireDrainPromise)
      return this.dnsExpireDrainPromise;
    if (this.dnsExpireRetry.size === 0 && this.dnsExpirePending.size === 0)
      return Promise.resolve();

    const retryBatch = this.dnsExpireRetry.size > 0;
    const pending = retryBatch
      ? this.dnsExpireRetry
      : this.dnsExpirePending;
    if (retryBatch)
      this.dnsExpireRetry = new Map();
    else
      this.dnsExpirePending = new Map();
    this.dnsExpireActive = pending;

    this.dnsExpireDrainPromise = (async () => {
      if (this.dnsExpireOverflowCount > 0) {
        log.warn(`Deferred rdns TTL refresh limit reached: ${MAX_DNS_EXPIRE_PENDING}; refreshed inline: ${this.dnsExpireOverflowCount}`);
        this.dnsExpireOverflowCount = 0;
      }
      const drainBatch = async (batch) => {
        this.dnsExpireActive = batch;
        const now = Date.now();
        for (const key of batch.keys()) {
          this.dnsExpireTs.set(key, now);
        }
        if (batch.size === 1) {
          const [key, expr] = batch.entries().next().value;
          await rclient.expireAsync(key, expr);
        } else {
          const multi = rclient.multi();
          for (const [key, expr] of batch) {
            multi.expire(key, expr);
          }
          await multi.execAsync();
        }
      };
      try {
        await drainBatch(pending);
        while (this.dnsExpireActiveUpdates.size > 0 || this.dnsExpirePending.size > 0) {
          for (const [key, expr] of this.dnsExpireActiveUpdates)
            this.dnsExpirePending.set(key, expr);
          this.dnsExpireActiveUpdates.clear();
          if (this.dnsExpirePending.size === 0)
            break;
          const newerPending = this.dnsExpirePending;
          this.dnsExpirePending = new Map();
          await drainBatch(newerPending);
        }
      } catch (err) {
        // Retry the failed bounded batch before newer refreshes on the next drain.
        const failedBatch = this.dnsExpireActive === pending ? pending : this.dnsExpireActive;
        this.dnsExpireRetry = new Map(failedBatch);
        for (const key of this.dnsExpireActiveUpdates.keys())
          this.dnsExpireRetry.delete(key);
        for (const [key, expr] of this.dnsExpireActiveUpdates)
          this.dnsExpirePending.set(key, expr);
        this.dnsExpireActiveUpdates.clear();
        log.error("Failed to flush deferred rdns TTL refreshes", err.message);
      }
    })().finally(() => {
      this.dnsExpireActive = null;
      this.dnsExpireDrainPromise = null;
    });
    return this.dnsExpireDrainPromise;
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

  async getSubDomains(domainSuffix) {
    const key = `subdomains:${domainSuffix}`;
    let domains = await rclient.smembersAsync(key) || [];
    if (_.isEmpty(domains)) {
      const pattern = `rdns:domain:*.${domainSuffix}`;
      const keys = await rclient.scanResults(pattern);
      domains = keys.map(k => k.substring("rdns:domain:".length));
      domains.push(domainSuffix); // add suffix itself
      await rclient.saddAsync(key, domains);
    }
    await rclient.expireAsync(key, 86400 * 7);
    return domains;
  }

  async addSubDomains(domainSuffix, domains) {
    const key = `subdomains:${domainSuffix}`;
    if (!_.isEmpty(domains)) {
      await rclient.saddAsync(key, domains);
      await rclient.expireAsync(key, 86400 * 7);
    }
  }

  async getIPsByDomain(domain) {
    let key = this.getReverseDNSKey(domain)
    let ips = await rclient.zrangeAsync(key, "0", "-1") || [];
    return ips.filter(ip => !firewalla.isReservedBlockingIP(ip));
  }

  async getIPsByDomainPattern(dnsPattern) {
    const domains = await this.getSubDomains(dnsPattern);

    let keys = domains.map(d => `rdns:domain:${d}`);

    let list = []
    if (keys) {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        let l = await rclient.zrangeAsync(key, "0", "-1")
        list.push.apply(list, l)
      }
    }

    return list.filter(ip => !firewalla.isReservedBlockingIP(ip)).filter((v, i, a) => a.indexOf(v) === i);
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
