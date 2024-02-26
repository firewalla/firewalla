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

const log = require("../net2/logger.js")(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient()

const Block = require('./Block.js');
const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();
const firewalla = require('../net2/Firewalla.js');
const _ = require('lodash')
const LRU = require('lru-cache');

const sem = require('../sensor/SensorEventManager.js').getInstance();

var instance = null;

class DomainUpdater {
  constructor() {
    if (instance == null) {
      this.updateOptions = {};
      instance = this;

      sem.on('Domain:Flush', async () => {
        try {
          await this.flush()
          log.info('Domain:Flush done')
        } catch(err) {
          log.error('Domain:Flush failed', err)
        }
      })
    }
    return instance;
  }

  registerUpdate(domain, options) {
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    // a secondary index for domain update options
    if (!this.updateOptions[domainKey])
      this.updateOptions[domainKey] = {};
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }
    // use mapping key to uniquely identify each domain mapping settings
    const key = domainIPTool.getDomainIPMappingKey(domain, options);
    const config = {domain: domain, options: options, ipCache: new LRU({maxAge: options.ipttl * 1000 / 2 || 0})}; // invalidate the entry in lru earlier than its ttl so that it can be re-added to the underlying ipset
    this.updateOptions[domainKey][key] = config;
  }

  unregisterUpdate(domain, options) {
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }
    const key = domainIPTool.getDomainIPMappingKey(domain, options);
    if (this.updateOptions[domainKey] && this.updateOptions[domainKey][key])
      delete this.updateOptions[domainKey][key];
  }

  async updateDomainMapping(domain, addresses) {
    if (!_.isString(domain)) return;

    const parentDomains = [domain];
    for (let i = 0; i < domain.length; i++) {
      if (domain[i] === '.') {
        while (domain[i] === '.' && i < domain.length)
          i++;
        if (i < domain.length)
          parentDomains.push(domain.substring(i));
      }
    }

    for (const domainKey of parentDomains) {
      if (!this.updateOptions[domainKey])
        continue;
      const DNSTool = require("../net2/DNSTool.js");
      const dnsTool = new DNSTool();

      for (const key in this.updateOptions[domainKey]) {
        const config = this.updateOptions[domainKey][key];
        const d = config.domain;
        const options = config.options;
        const ipCache = config.ipCache || null;

        if (domain.toLowerCase() === d.toLowerCase()
          || !options.exactMatch && domain.toLowerCase().endsWith("." + d.toLowerCase())) {
          if (!options.exactMatch) {
            await dnsTool.addSubDomains(d, [domain]);
          }
          const existingAddresses = await domainIPTool.getMappedIPAddresses(d, options);
          const existingSet = {};
          existingAddresses.forEach((addr) => {
            existingSet[addr] = 1;
          });
          addresses = addresses.filter((addr) => { // ignore reserved blocking ip addresses
            return firewalla.isReservedBlockingIP(addr) != true;
          });
          let blockSet = "block_domain_set";
          let updateIpsetNeeded = false;
          if (options.blockSet)
            blockSet = options.blockSet;
          const ipttl = options.ipttl || null;

          for (let i in addresses) {
            const address = addresses[i];
            if (!existingSet[address] || (Number.isInteger(ipttl) && ipCache && !ipCache.get(address))) {
              updateIpsetNeeded = true;
              ipCache && ipCache.set(address, 1);
              await rclient.saddAsync(key, address);
            }
          }
          if (updateIpsetNeeded) {
            // add comment string to ipset, @ to indicate dynamically updated.
            if (options.needComment) {
              options.comment = `${domain}@`;
            }
            if (options.port) {
              await Block.batchBlockNetPort(addresses, options.port, blockSet, options).catch((err) => {
                log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
              });
            } else {
              await Block.batchBlock(addresses, blockSet, options).catch((err) => {
              log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
            });
            }
          }
        }
      }
    }
  }

  async flush() {
    // for (const domainKey of this.updateOptions) {
    //   for (const key of this.updateOptions[domainKey]) {
    //     this.updateOptions[domainKey][key].ipCache.clear()
    //   }
    // }
    this.updateOptions = {}

    const ipmappingKeys = await rclient.scanResults('ipmapping:*')
    ipmappingKeys.length && await rclient.unlinkAsync(ipmappingKeys)
  }
}

module.exports = DomainUpdater;
