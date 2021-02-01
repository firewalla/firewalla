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
const rclient = require('../util/redis_manager.js').getRedisClient();

var instance = null;

class DomainIPTool {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  getDomainIPMappingKey(domain, options) {
    options = options || {}

    if(this.externalMapping) {
      return this.externalMapping
    }

    let prefix = 'ipmapping';
    if (options.blockSet) {
      // create separate ip mapping set for specific block set
      prefix = `ipmapping:blockset:${options.blockSet}`;
    }

    if(options.exactMatch) {
      return `${prefix}:exactdomain:${domain}`
    } else {
      return `${prefix}:domain:${domain}`
    }    
  }

  async removeDomainIPMapping(domain, options) {
    const key = this.getDomainIPMappingKey(domain, options)
    await rclient.delAsync(key)
  }

  async removeAllDomainIPMapping() {
    const patternDomainKey = `ipmapping:domain:*`
    const domainKeys = await rclient.scanResults(patternDomainKey)
    if(domainKeys && domainKeys.length > 0) {
      await rclient.delAsync(domainKeys);
    }

    const patternExactDomainKey = `ipmapping:exactdomain:*`
    const exactDomainKeys = await rclient.scanResults(patternExactDomainKey)
    if(exactDomainKeys && exactDomainKeys.length > 0) {
      await rclient.delAsync(exactDomainKeys);
    }

    const patternBlocksetDomainKey = `ipmapping:blockset:*`
    const blocksetDomainKeys = await rclient.scanResults(patternBlocksetDomainKey)
    if (blocksetDomainKeys && blocksetDomainKeys.length > 0) {
      await rclient.delAsync(blocksetDomainKeys);
    }
  }

  async getMappedIPAddresses(domain, options) {
    const key = this.getDomainIPMappingKey(domain, options)
    const addresses = await rclient.smembersAsync(key)
    return addresses;
  }

  async getAllIPMappings() {
    const list = await rclient.scanResults("ipmapping:*")
    return list
  }

  async removeAllIPMappings() {
    const list = await this.getAllIPMappings()
    if(list && list.length > 0) {
      await rclient.delAsync(list)
    }
  }
}

module.exports = DomainIPTool;