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
    for (let key in this.updateOptions) {
      const config = this.updateOptions[key];
      const d = config.domain;
      const options = config.options;
      let matched = false;
      if (options.exactMatch) {
        if (domain === d) {
          matched = true;
        }
      } else {
        if (domain.endsWith("." + d)) {
          matched = true;
        }
      }
      if (matched) {
        const existingAddresses = await domainIPTool.getMappedIPAddresses(domain, options);
        const existingSet = {};
        existingAddresses.forEach((addr) => {
          existingSet[addr] = 1;
        });
        for (let i in addresses) {
          const address = addresses[i];
          if (!existingSet[address]) {
            await rclient.saddAsync(key, address);
            let blockSet = "blocked_domain_set";
            if (options.blockSet)
              blockSet = options.blockSet;
            if (!options.ignoreApplyBlock)
              await Block.block(address, blockSet);
          }
        }
      }
    }
  }
}

module.exports = DomainUpdater;