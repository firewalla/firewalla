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

const log = require("../net2/logger.js")(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const dns = require('dns');
const util = require('util');
const resolver = new dns.Resolver();
let resolve4Async;
let resolve6Async;
const fc = require('../net2/config.js');
const dc = require('../extension/dnscrypt/dnscrypt');

const sysManager = require("../net2/SysManager.js")

const sem = require('../sensor/SensorEventManager.js').getInstance()
const DomainUpdater = require('./DomainUpdater.js');
const domainUpdater = new DomainUpdater();
const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();

const BlockManager = require('../control/BlockManager.js');
const blockManager = new BlockManager();

const _ = require('lodash');
class DomainBlock {

  constructor() {

  }

  // a mapping from domain to ip is tracked in redis, so that we can apply block at ip level, which is more secure
  async blockDomain(domain, options) {
    options = options || {}
    log.info(`Implementing Block on ${domain}`);

    await this.syncDomainIPMapping(domain, options)
    domainUpdater.registerUpdate(domain, options);
    if (!options.ignoreApplyBlock) {
      await this.applyBlock(domain, options);
    }

    // setTimeout(() => {
    //   this.incrementalUpdateIPMapping(domain, options)
    // }, 60 * 1000) // reinforce in 60 seconds
  }

  async unblockDomain(domain, options) {
    await this.unapplyBlock(domain, options);

    if (!this.externalMapping) {
      await domainIPTool.removeDomainIPMapping(domain, options);
    }

    domainUpdater.unregisterUpdate(domain, options);
  }

  async applyBlock(domain, options) {
    const blockSet = options.blockSet || "block_domain_set";
    const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
    if (addresses) {
      const ipLevelBlockAddrs = [];
      for (const addr of addresses) {
        try {
          const ipBlockInfo = await blockManager.updateIpBlockInfo(addr, domain, 'block', blockSet);
          if (ipBlockInfo.blockLevel == 'ip') {
            ipLevelBlockAddrs.push(addr);
          }
        } catch (err) { }
      }
      await Block.batchBlock(ipLevelBlockAddrs, blockSet).catch((err) => {
        log.error(`Failed to batch block domain ${domain} in ${blockSet}`, err.message);
      });
    }
  }

  async unapplyBlock(domain, options) {
    const blockSet = options.blockSet || "block_domain_set"

    const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
    if (addresses) {
      for (const addr of addresses) {
        try {
          await blockManager.updateIpBlockInfo(addr, domain, 'unblock', blockSet);
        } catch (err) { }
      }
      await Block.batchUnblock(addresses, blockSet).catch((err) => {
        log.error(`Failed to batch unblock domain ${domain} in ${blockSet}`, err.message);
      });
    }
  }

  resolve4WithTimeout(domain, timeout) {
    let callbackCalled = false

    return new Promise((resolve, reject) => {
      resolve4Async(domain).then((addresses) => {
        if (!callbackCalled) {
          callbackCalled = true
          resolve(addresses)
        }
      }).catch((err) => {
        if (!callbackCalled) {
          callbackCalled = true
          resolve([]) // return empty array in case any error
        }
      })
      setTimeout(() => {
        if (!callbackCalled) {
          callbackCalled = true
          resolve([]) // return empty array in case timeout
        }
      }, timeout)
    })
  }

  resolve6WithTimeout(domain, timeout) {
    let callbackCalled = false

    return new Promise((resolve, reject) => {
      resolve6Async(domain).then((addresses) => {
        if (!callbackCalled) {
          callbackCalled = true
          resolve(addresses)
        }
      }).catch((err) => {
        if (!callbackCalled) {
          callbackCalled = true
          resolve([]) // return empty array in case any error
        }
      })
      setTimeout(() => {
        if (!callbackCalled) {
          log.warn("Timeout when query domain", domain)
          callbackCalled = true
          resolve([]) // return empty array in case timeout
        }
      }, timeout)
    })
  }

  async resolveDomain(domain) {
    if (fc.isFeatureOn('doh')) {
      const server = `127.0.0.1:${dc.getLocalPort()}`;
      if (!this.setUpServers) {
        resolver.setServers([server]);
        this.setUpServers = true;
      }
      resolve4Async = util.promisify(resolver.resolve4.bind(resolver));
      resolve6Async = util.promisify(resolver.resolve6.bind(resolver));
    } else {
      resolve4Async = util.promisify(dns.resolve4);
      resolve6Async = util.promisify(dns.resolve6);
    }
    const v4Addresses = await this.resolve4WithTimeout(domain, 3 * 1000).catch((err) => []); // 3 seconds for timeout
    await dnsTool.addReverseDns(domain, v4Addresses);

    const gateway6 = sysManager.myGateway6()
    if (gateway6) { // only query if ipv6 is supported
      const v6Addresses = await this.resolve6WithTimeout(domain, 3 * 1000).catch((err) => []);
      await dnsTool.addReverseDns(domain, v6Addresses);
      return v4Addresses.concat(v6Addresses)
    } else {
      return v4Addresses
    }
  }

  async syncDomainIPMapping(domain, options) {
    options = options || {}

    const key = domainIPTool.getDomainIPMappingKey(domain, options)

    await this.resolveDomain(domain); // this will resolve domain via dns and add entries into reverse dns directly

    let list = []

    // load other addresses from rdns, critical to apply instant blocking
    const addresses = await dnsTool.getIPsByDomain(domain).catch((err) => []);
    list.push.apply(list, addresses)  // concat arrays

    if (!options.exactMatch) {
      const patternAddresses = await dnsTool.getIPsByDomainPattern(domain).catch((err) => []);
      list.push.apply(list, patternAddresses)
    }

    return rclient.saddAsync(key, list)
  }

  // incremental update mapping to reinforce ip blocking
  // this function should be executed in a serial way with other policy enforcements to avoid race conditions
  async incrementalUpdateIPMapping(domain, options) {
    options = options || {}

    log.info("Incrementally updating blocking list for", domain)

    const key = domainIPTool.getDomainIPMappingKey(domain, options)

    const existing = await rclient.existsAsync(key);

    if (!existing) {
      return
    }

    await this.resolveDomain(domain); // this will resolve domain via dns and add entries into reverse dns directly

    let set = {}

    // load other addresses from rdns, critical to apply instant blocking
    const addresses = await dnsTool.getIPsByDomain(domain).catch((err) => []);
    addresses.forEach((addr) => {
      set[addr] = 1
    })

    if (!options.exactMatch) {
      const patternAddresses = await dnsTool.getIPsByDomainPattern(domain).catch((err) => []);
      patternAddresses.forEach((addr) => {
        set[addr] = 1
      })
    }

    const existingAddresses = await domainIPTool.getMappedIPAddresses(domain, options);

    let existingSet = {}
    existingAddresses.forEach((addr) => {
      existingSet[addr] = 1
    })

    // only add new changed ip addresses, there is no need to remove any old ip addrs
    for (let addr in set) {
      if (!existingSet[addr]) {
        await rclient.saddAsync(key, addr);
        let blockSet = "block_domain_set";
        if (options.blockSet)
          blockSet = options.blockSet;
        await Block.block(addr, blockSet).catch((err) => undefined);
      }
    }
  }

  async blockCategory(category, options) {
    const domains = await this.getCategoryDomains(category);
    await dnsmasq.addPolicyCategoryFilterEntry(domains, options).catch((err) => undefined);
    dnsmasq.scheduleRestartDNSService();
  }

  async unblockCategory(category, options) {
    const domains = await this.getCategoryDomains(category);
    await dnsmasq.removePolicyCategoryFilterEntry(domains, options).catch((err) => undefined);
    dnsmasq.scheduleRestartDNSService();
  }

  async updateCategoryBlock(category) {
    const domains = await this.getCategoryDomains(category);
    await dnsmasq.updatePolicyCategoryFilterEntry(domains, { category: category });
    const PM2 = require('../alarm/PolicyManager2.js');	
    const pm2 = new PM2();	
    const policies = await pm2.loadActivePoliciesAsync();	
    for (const policy of policies) {	
      if (policy.type == "category" && policy.target == category) {	
        dnsmasq.scheduleRestartDNSService();
        return;
      }	
    }
  }

  async getCategoryDomains(category) {
    const CategoryUpdater = require('./CategoryUpdater.js');
    const categoryUpdater = new CategoryUpdater();
    const domains = await categoryUpdater.getDomainsWithExpireTime(category);
    const excludedDomains = await categoryUpdater.getExcludedDomains(category);
    const defaultDomains = await categoryUpdater.getDefaultDomains(category);
    const includedDomains = await categoryUpdater.getIncludedDomains(category);
    const finalDomains = domains.filter((de) => {
      return !excludedDomains.includes(de.domain) && !defaultDomains.includes(de.domain)
    }).map((de) => { return de.domain }).concat(defaultDomains, includedDomains)

    function dedupAndPattern(arr) {
      const pattern = arr.filter((domain) => {
        return domain.startsWith("*.")
      }).map((domain) => domain.substring(2))
      return Array.from(new Set(arr.filter((domain) => {
        if (!domain.startsWith("*.") && pattern.includes(domain)) {
          return false;
        } else if (domain.startsWith("*.")) {
          return false;
        } else {
          return true;
        }
      }).concat(pattern)))
    }
    return dedupAndPattern(finalDomains)
  }

  patternDomain(domain) {
    domain = domain || "";
    if (domain.startsWith("*.")) {
      domain = domain.substring(2);
    }
    return domain;
  }
}

module.exports = () => new DomainBlock()
