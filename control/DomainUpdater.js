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

const Block = require('./Block.js');
const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();
const firewalla = require('../net2/Firewalla.js');
const _ = require('lodash')
const LRU = require('lru-cache');

var instance = null;

class DomainUpdater {
  constructor() {
    if (instance == null) {
      this.updateOptions = {};
      instance = this;
    }
    return instance;
  }

  registerUpdate(domain, options) {
    // use mapping key to uniquely identify each domain mapping settings
    const key = domainIPTool.getDomainIPMappingKey(domain, options);
    const config = {domain: domain, options: options, ipCache: new LRU({maxAge: options.ipttl / 2 || 0})}; // invalidate the entry in lru earlier than its ttl so that it can be re-added to the underlying ipset
    this.updateOptions[key] = config;
  }

  unregisterUpdate(domain, options) {
    const key = domainIPTool.getDomainIPMappingKey(domain, options);
    if (this.updateOptions[key])
      delete this.updateOptions[key];
  }

  async updateDomainMapping(domain, addresses) {
    if (!_.isString(domain)) return;

    for (const key in this.updateOptions) {
      const config = this.updateOptions[key];
      const d = config.domain;
      const options = config.options;
      const ipCache = config.ipCache || null;

      if (domain.toLowerCase() === d.toLowerCase()
        || !options.exactMatch && domain.toLowerCase().endsWith("." + d.toLowerCase())
        || d.startsWith("*.") && domain.toLowerCase().endsWith(d.toLowerCase().substring(1))) {
        const existingAddresses = await domainIPTool.getMappedIPAddresses(d, options);
        const existingSet = {};
        existingAddresses.forEach((addr) => {
          existingSet[addr] = 1;
        });
        addresses = addresses.filter((addr) => { // ignore reserved blocking ip addresses
          return firewalla.isReservedBlockingIP(addr) != true;
        });
        let blockSet = "block_domain_set";
        const ipLevelBlockAddrs = [];
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
            if (!options.ignoreApplyBlock){
              const BlockManager = require('./BlockManager.js');
              const blockManager = new BlockManager();
              const ipBlockInfo = await blockManager.updateIpBlockInfo(address, config.domain, 'block', blockSet);
              if (ipBlockInfo.blockLevel == 'ip') {
                ipLevelBlockAddrs.push(address);
              }
            }
          }
        }
        if (!options.ignoreApplyBlock && updateIpsetNeeded)
          await Block.batchBlock(ipLevelBlockAddrs, blockSet).catch((err) => {
            log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
          });
      }
    }
  }
}

module.exports = DomainUpdater;
