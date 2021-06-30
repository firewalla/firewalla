/*    Copyright 2016-2021 Firewalla Inc.
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

const fs = require('fs');
const appendFileAsync = util.promisify(fs.appendFile);

const sysManager = require("../net2/SysManager.js")

const DomainUpdater = require('./DomainUpdater.js');
const domainUpdater = new DomainUpdater();
const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();


const _ = require('lodash');
const exec = require('child-process-promise').exec;
const tlsHostSetPath = "/proc/net/xt_tls/hostset/";

class DomainBlock {

  constructor() {

  }

  // a mapping from domain to ip is tracked in redis, so that we can apply block at ip level, which is more secure
  async blockDomain(domain, options) {
    options = options || {}
    domain = domain && domain.toLowerCase();
    log.debug(`Implementing Block on ${domain}`);

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
      await Block.batchBlock(addresses, blockSet).catch((err) => {
        log.error(`Failed to batch block domain ${domain} in ${blockSet}`, err.message);
      });
    }
    const tlsHostSet = options.tlsHostSet;
    if (tlsHostSet) {
      const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;
      await appendFileAsync(tlsFilePath, `+${domain}`).catch((err) => {
        log.error(`Failed to add ${d} to tls host set ${tlsFilePath}`, err.message);
      });
    }
  }

  async unapplyBlock(domain, options) {
    const blockSet = options.blockSet || "block_domain_set"

    const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
    if (addresses) {
      await Block.batchUnblock(addresses, blockSet).catch((err) => {
        log.error(`Failed to batch unblock domain ${domain} in ${blockSet}`, err.message);
      });
    }
    const tlsHostSet = options.tlsHostSet;
    if (tlsHostSet) {
      const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;
      await appendFileAsync(tlsFilePath, `-${domain}`).catch((err) => {
        log.error(`Failed to remove ${d} from tls host set ${tlsFilePath}`, err.message);
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
        try {
          resolver.setServers([server]);
          this.setUpServers = true;
        } catch (err) {
          log.warn('set resolver servers error', err);
        }
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

    let list = []

    // *. wildcard will exclude the suffix itself
    if (!domain.startsWith("*.")) {
      if (!options.ondemand) await this.resolveDomain(domain); // this will resolve domain via dns and add entries into reverse dns directly
      // load other addresses from rdns, critical to apply instant blocking
      const addresses = await dnsTool.getIPsByDomain(domain).catch((err) => []);
      list.push.apply(list, addresses)  // concat arrays
    }

    if (!options.exactMatch || domain.startsWith("*.")) {
      const suffix = domain.startsWith("*.") ? domain.substring(2) : domain;
      const patternAddresses = await dnsTool.getIPsByDomainPattern(suffix).catch((err) => []);
      list.push.apply(list, patternAddresses)
    }

    if (options.overwrite === true) // regenerate entire ipmapping: set if overwrite is set
      await rclient.delAsync(key);

    if (list.length === 0)
      return;

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

    let set = {}

    if (!domain.startsWith("*.")) {
      await this.resolveDomain(domain); // this will resolve domain via dns and add entries into reverse dns directly
      // load other addresses from rdns, critical to apply instant blocking
      const addresses = await dnsTool.getIPsByDomain(domain).catch((err) => []);
      addresses.forEach((addr) => {
        set[addr] = 1
      })
    }

    if (!options.exactMatch || domain.startsWith("*.")) {
      const suffix = domain.startsWith("*.") ? domain.substring(2) : domain;
      const patternAddresses = await dnsTool.getIPsByDomainPattern(suffix).catch((err) => []);
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
    if (!options.category)
      options.category = category;
    await dnsmasq.addPolicyCategoryFilterEntry(options).catch((err) => undefined);
    dnsmasq.scheduleRestartDNSService();
  }

  async unblockCategory(category, options) {
    if (!options.category)
      options.category = category;
    await dnsmasq.removePolicyCategoryFilterEntry(options).catch((err) => undefined);
    dnsmasq.scheduleRestartDNSService();
  }

  // this function updates category domain mappings in dnsmasq configurations
  async updateCategoryBlock(category) {
    const domains = await this.getCategoryDomains(category);
    await dnsmasq.updatePolicyCategoryFilterEntry(domains, { category: category });
  }

  async appendDomainToCategoryTLSHostSet(category, domain) {
    const tlsHostSet = Block.getTLSHostSet(category);
    const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;

    try {
      await appendFileAsync(tlsFilePath, `+${domain}`); // + => add
    } catch(err) {
      log.error(`Failed to add domain ${domain} to tls ${tlsFilePath}, err: ${err}`);
    }

  }

  // flush and re-create from redis
  async refreshTLSCategory(category) {
    const domains = await this.getCategoryDomains(category);
    const tlsHostSet = Block.getTLSHostSet(category);
    const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;
    
    // flush first
    await appendFileAsync(tlsFilePath, "/").catch((err) => log.error(`got error when flushing ${tlsFilePath}, err: ${err}`)); // / => flush

    // use fs.writeFile intead of bash -c "echo +domain > ..." to avoid too many process forks
    for (const domain of domains) {
      await appendFileAsync(tlsFilePath, `+${domain}`).catch((err) => log.error(`got error when adding ${domain} to ${tlsFilePath}, err: ${err}`));
    }
  }
  
  async getCategoryDomains(category) {
    const CategoryUpdater = require('./CategoryUpdater.js');
    const categoryUpdater = new CategoryUpdater();
    const domains = await categoryUpdater.getDomainsWithExpireTime(category);
    const excludedDomains = await categoryUpdater.getExcludedDomains(category);
    const defaultDomains = await categoryUpdater.getDefaultDomains(category);
    const defaultDomainsOnly = await categoryUpdater.getDefaultDomainsOnly(category);
    const hashedDomains = await categoryUpdater.getDefaultHashedDomains(category);
    const includedDomains = await categoryUpdater.getIncludedDomains(category);
    const superSetDomains = domains.map(de => de.domain)
      .concat(defaultDomains, includedDomains, defaultDomainsOnly)

    const splitedNames = superSetDomains.map(d => {
      const splited = d.split('.')
      if (splited[0] == '*') splited.shift()
      return splited.reverse()
    }).sort()

    // O(n) domain dedup, assuming exclude list is much smaller than super set
    const resultDomains = []
    let i = 0
    while (i < splitedNames.length) {
      const base = splitedNames[i]
      let j = i + 1
      while ( j < splitedNames.length && _.isEqual(splitedNames[j].slice(0, base.length), base) ) j++
      const original = base.reverse().join('.')
      if (!excludedDomains.some(d => original.endsWith(d))) resultDomains.push(original)
      i = j
    }

    return resultDomains.concat(hashedDomains)
  }

  patternDomain(domain) {
    domain = domain || "";
    if (domain.startsWith("*.")) {
      domain = domain.substring(2);
    }
    return domain;
  }
}

module.exports = new DomainBlock()
