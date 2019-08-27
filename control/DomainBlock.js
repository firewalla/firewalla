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
const resolve4Async = util.promisify(dns.resolve4)
const resolve6Async = util.promisify(dns.resolve6)

const SysManager = require("../net2/SysManager.js")
const sysManager = new SysManager()

const sem = require('../sensor/SensorEventManager.js').getInstance()
const DomainUpdater = require('./DomainUpdater.js');
const domainUpdater = new DomainUpdater();

const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();

class DomainBlock {

  constructor() {
  }

  // a mapping from domain to ip is tracked in redis, so that we can apply block at ip level, which is more secure
  async blockDomain(domain, options) {
    options = options || {}
    log.info(`Implementing Block on ${domain}`);

    if(!options.no_dnsmasq_entry) {
      await dnsmasq.addPolicyFilterEntry(domain, options).catch((err) => undefined);
    }

    if(!options.no_dnsmasq_reload) {
      sem.emitEvent({
        type: 'ReloadDNSRule',
        message: 'DNSMASQ filter rule is updated',
        toProcess: 'FireMain',
        suppressEventLogging: true
      })
    }

    await this.syncDomainIPMapping(domain, options)
    domainUpdater.registerUpdate(domain, options);
    if(!options.ignoreApplyBlock) {
      await this.applyBlock(domain, options);
    }

    // setTimeout(() => {
    //   this.incrementalUpdateIPMapping(domain, options)
    // }, 60 * 1000) // reinforce in 60 seconds
  }

  async unblockDomain(domain, options) {
    if(!options.ignoreUnapplyBlock) {
      await this.unapplyBlock(domain, options);
    }

    if(!this.externalMapping) {
      await domainIPTool.removeDomainIPMapping(domain, options);
    }

    domainUpdater.unregisterUpdate(domain, options);

    if(!options.no_dnsmasq_entry) {
      await dnsmasq.removePolicyFilterEntry(domain).catch((err) => undefined);
    }

    if(!options.no_dnsmasq_reload) {
      sem.emitEvent({
        type: 'ReloadDNSRule',
        message: 'DNSMASQ filter rule is updated',
        toProcess: 'FireMain',
        suppressEventLogging: true,
      })
    }
  }

  async applyBlock(domain, options) {
    const blockSet = options.blockSet || "blocked_domain_set"
    const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
    if(addresses) {
      for (const addr of addresses) {
        try {
          await Block.block(addr, blockSet)
        } catch(err) {}
      }
    }
  }

  async unapplyBlock(domain, options) {
    const blockSet = options.blockSet || "blocked_domain_set"

    const addresses = await domainIPTool.getMappedIPAddresses(domain, options);
    if(addresses) {
      for (const addr of addresses) {
        try {
          Block.unblock(addr, blockSet)
        } catch(err) {}
      }
    }
  }

  resolve4WithTimeout(domain, timeout) {
    let callbackCalled = false

    return new Promise((resolve, reject) => {
      resolve4Async(domain).then((addresses) => {
        if(!callbackCalled) {
          callbackCalled = true
          resolve(addresses)
        }
      }).catch((err) => {
        if(!callbackCalled) {
          callbackCalled = true
          resolve([]) // return empty array in case any error
        }
      })
      setTimeout(() => {
        if(!callbackCalled) {
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
        if(!callbackCalled) {
          callbackCalled = true
          resolve(addresses)
        }
      }).catch((err) => {
        if(!callbackCalled) {
          callbackCalled = true
          resolve([]) // return empty array in case any error
        }
      })
      setTimeout(() => {
        if(!callbackCalled) {
          log.warn("Timeout when query domain", domain)
          callbackCalled = true
          resolve([]) // return empty array in case timeout
        }
      }, timeout)
    })
  }

  async resolveDomain(domain) {
    const v4Addresses = await this.resolve4WithTimeout(domain, 3 * 1000).catch((err) => []); // 3 seconds for timeout
    await dnsTool.addReverseDns(domain, v4Addresses);

    const gateway6 = sysManager.myGateway6()
    if(gateway6) { // only query if ipv6 is supported
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

    if(!options.exactMatch) {
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

    if(!existing) {
      return
    }

    await this.resolveDomain(domain); // this will resolve domain via dns and add entries into reverse dns directly

    let set = {}

    // load other addresses from rdns, critical to apply instant blocking
    const addresses = await dnsTool.getIPsByDomain(domain).catch((err) => []);
    addresses.forEach((addr) => {
      set[addr] = 1
    })

    if(!options.exactMatch) {
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
    for(let addr in set) {
      if(!existingSet[addr]) {
        await rclient.saddAsync(key,addr);
        let blockSet = "blocked_domain_set";
        if (options.blockSet)
          blockSet = options.blockSet;
        await Block.block(addr, blockSet).catch((err) => undefined);
      }
    }
  }
}

module.exports = () => new DomainBlock()
