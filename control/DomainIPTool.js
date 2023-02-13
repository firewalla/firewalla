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

const { CategoryEntry } = require("./CategoryEntry.js");

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
    if (options.port) {
      prefix = `${prefix}:${CategoryEntry.toPortStr(options.port)}`;
    }
    if(options.exactMatch) {
      return `${prefix}:exactdomain:${domain}`
    } else {
      return `${prefix}:domain:${domain}`
    }    
  }

  async removeDomainIPMapping(domain, options) {
    const key = this.getDomainIPMappingKey(domain, options)
    await rclient.unlinkAsync(key)
  }

  async removeAllDomainIPMapping() {
    await Promise.all([
      `ipmapping:domain:*`,
      `ipmapping:exactdomain:*`,
      `ipmapping:blockset:*`,
    ].map(async pattern => {
      const keys = await rclient.scanResults(pattern)
      if (keys && keys.length > 0) {
        await rclient.unlinkAsync(keys);
      }
    }))
  }

  async getMappedIPAddresses(domain, options) {
    const key = this.getDomainIPMappingKey(domain, options)
    const addresses = await rclient.smembersAsync(key)
    return addresses;
  }

  async getAllIPMappings() {
    const list = await rclient.keysAsync("ipmapping:*")
    return list
  }

  async removeAllIPMappings() {
    const list = await this.getAllIPMappings()
    if(list && list.length > 0) {
      await rclient.unlinkAsync(list)
    }
  }
}

module.exports = DomainIPTool;
