/*    Copyright 2016-2022 Firewalla Inc.
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
const { CategoryEntry } = require('./CategoryEntry');

const _ = require('lodash');

const tlsHostSetPath = "/proc/net/xt_tls/hostset/";

class DomainBlock {

  constructor() {

  }

  // a mapping from domain to ip is tracked in redis, so that we can apply block at ip level, which is more secure
  async blockDomain(domain, options) {
    options = options || {}
    domain = domain && domain.toLowerCase();
    log.debug(`Implementing Block on ${domain}`);

    if (!options.noIpsetUpdate) {
      domainUpdater.registerUpdate(domain, options);
      // do not execute full update on ipset if ondemand is set
      if (!options.ondemand) {
        await this.syncDomainIPMapping(domain, options)
      }
    }
    if (!options.ondemand)
      await this.applyBlock(domain, options);

    // setTimeout(() => {
    //   this.incrementalUpdateIPMapping(domain, options)
    // }, 60 * 1000) // reinforce in 60 seconds
  }

  async unblockDomain(domain, options) {
    if (!options.skipUnapply) {
      await this.unapplyBlock(domain, options);
    }

    if (!this.externalMapping) {
      await domainIPTool.removeDomainIPMapping(domain, options);
    }

    domainUpdater.unregisterUpdate(domain, options);
  }

  async applyBlock(domain, options) {
    if (!options.noIpsetUpdate) {
      const blockSet = options.blockSet || "block_domain_set";
      const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
      if (addresses) {
        if (options.port) {
          await Block.batchBlockNetPort(addresses, options.port, blockSet).catch((err) => {
            log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
          });
        } else {
          await Block.batchBlock(addresses, blockSet).catch((err) => {
            log.error(`Failed to batch block domain ${domain} in ${blockSet}`, err.message);
          });
        }
      }
    }
    const tlsHostSet = options.tlsHostSet;
    if (tlsHostSet) {
      const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;
      const finalDomain = options.exactMatch || domain.startsWith("*.") ? domain : `*.${domain}`; // check domain.startsWith just for double check
      await appendFileAsync(tlsFilePath, `+${finalDomain}`).catch((err) => {
        log.error(`Failed to add ${finalDomain} to tls host set ${tlsFilePath}`, err.message);
      });
    }
  }

  async unapplyBlock(domain, options) {
    if (!options.noIpsetUpdate) {
      const blockSet = options.blockSet || "block_domain_set"

      const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
      if (addresses) {
        await Block.batchUnblock(addresses, blockSet).catch((err) => {
          log.error(`Failed to batch unblock domain ${domain} in ${blockSet}`, err.message);
        });
      }
    }
    const tlsHostSet = options.tlsHostSet;
    if (tlsHostSet) {
      const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;
      const finalDomain = options.exactMatch || domain.startsWith("*.") ? domain : `*.${domain}`; // check domain.startsWith just for double check
      await appendFileAsync(tlsFilePath, `-${finalDomain}`).catch((err) => {
        log.error(`Failed to remove ${finalDomain} from tls host set ${tlsFilePath}`, err.message);
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
      await rclient.unlinkAsync(key);

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
    const CategoryUpdater = require("./CategoryUpdater.js");
    const strategy = await (new CategoryUpdater()).getStrategy(category);
    if (strategy.dnsmasq.useFilter) {
      // update hashed domain anyway
      const domains = await this.getCategoryDomains(category, true);
      log.debug('updateCategoryBlock', category, domains)
      await dnsmasq.updatePolicyCategoryFilterEntry(domains, { category: category });
    } else {
      const domains = await this.getCategoryDomains(category, false);
      log.debug('updateCategoryBlock', category, domains)
      await dnsmasq.updatePolicyCategoryFilterEntry(domains, { category: category });
    }
  }

  async appendDomainToCategoryTLSHostSet(category, domain) {
    const tlsHostSet = Block.getTLSHostSet(category);
    const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;

    try {
      await appendFileAsync(tlsFilePath, `+${domain}`); // + => add
    } catch (err) {
      log.error(`Failed to add domain ${domain} to tls ${tlsFilePath}, err: ${err}`);
    }

  }

  // flush and re-create from redis
  async refreshTLSCategory(category) {
    const CategoryUpdater = require("./CategoryUpdater.js");
    const strategy = await (new CategoryUpdater()).getStrategy(category);
    const domains = await this.getCategoryDomains(category, strategy.tls.useHitSet);
    const tlsHostSet = Block.getTLSHostSet(category);
    const tlsFilePath = `${tlsHostSetPath}/${tlsHostSet}`;

    // flush first
    await appendFileAsync(tlsFilePath, "/").catch((err) => log.error(`got error when flushing ${tlsFilePath}, err: ${err}`)); // / => flush

    // use fs.writeFile intead of bash -c "echo +domain > ..." to avoid too many process forks
    for (const domain of domains) {
      await appendFileAsync(tlsFilePath, `+${domain}`).catch((err) => log.error(`got error when adding ${domain} to ${tlsFilePath}, err: ${err}`));
    }

    const domainsWithPort = await this.getCategoryDomainsWithPort(category);

    for (const domainObj of domainsWithPort) {
      const portObj = domainObj.port;
      const entry = `${domainObj.id},${CategoryEntry.toPortStr(portObj)}`;
      log.debug("Tls port entry:", entry);
      await appendFileAsync(tlsFilePath, `+${entry}`).catch((err) => log.error(`got error when adding ${entry} to ${tlsFilePath}, err: ${err}`));
    }
  }

  // dynamic + default + defaultDomainOnly - exclude + include + hashed
  async getCategoryDomains(category, useHitSet = null) {
    const CategoryUpdater = require("./CategoryUpdater.js");
    const categoryUpdater = new CategoryUpdater();
    if (useHitSet === null || useHitSet === undefined) {
      useHitSet = (await categoryUpdater.getStrategy(category)).useHitSetDefault;
    }

    const domains = await categoryUpdater.getDomains(category);
    const excludedDomains = await categoryUpdater.getExcludedDomains(category);
    const defaultDomains = useHitSet
      ? await categoryUpdater.getHitDomains(category)
      : await categoryUpdater.getDefaultDomains(category);
    const defaultDomainsOnly = await categoryUpdater.getDefaultDomainsOnly(category);
    const hashedDomains = await categoryUpdater.getDefaultHashedDomains(category);
    const includedDomains = await categoryUpdater.getIncludedDomains(category);
    // exclude domains work as a simple remover for default/dynamic set, it has lower priority than include domain as
    // user could only manage include domains on client now
    const superSetDomains = domains.concat(defaultDomains, defaultDomainsOnly)
      .filter(d => !excludedDomains.some(ed => ed === d))
      .concat(includedDomains)

    // *.domain and domain has different semantic in category domains, one for suffix match and the other for exact match
    const wildcardDomains = superSetDomains.filter(d => d.startsWith("*."));
    const resultDomains = _.uniq(superSetDomains.filter(d => wildcardDomains.includes(d) || !wildcardDomains.some(wd => d.endsWith(wd.substring(1)) || d === wd.substring(2))) // remove duplicate domains that are covered by wildcard domains
    );

    return resultDomains.concat(hashedDomains)
  }

  async getCategoryDomainsWithPort(category) {
    const CategoryUpdater = require("./CategoryUpdater.js");
    const categoryUpdater = new CategoryUpdater();
    return await categoryUpdater.getAllDomainsWithPort(category);
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
