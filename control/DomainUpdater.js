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
    const config = {domain: domain, options: options};
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

      if (options.exactMatch && domain === d || domain.endsWith("." + d)) {
        const existingAddresses = await domainIPTool.getMappedIPAddresses(domain, options);
        const existingSet = {};
        existingAddresses.forEach((addr) => {
          existingSet[addr] = 1;
        });
        addresses = addresses.filter((addr) => { // ignore reserved blocking ip addresses
          return firewalla.isReservedBlockingIP(addr) != true;
        });
        for (let i in addresses) {
          const address = addresses[i];
          if (!existingSet[address]) {
            await rclient.saddAsync(key, address);
            let blockSet = "blocked_domain_set";
            if (options.blockSet)
              blockSet = options.blockSet;
            if (!options.ignoreApplyBlock){
              const BlockManager = require('./BlockManager.js');
              const blockManager = new BlockManager();
              const ipBlockInfo = await blockManager.updateIpBlockInfo(address, config.domain, 'block', blockSet);
              if (ipBlockInfo.blockLevel == 'ip') {
                await Block.block(address, blockSet)
              }
            }
          }
        }
      }
    }
  }
}

module.exports = DomainUpdater;
