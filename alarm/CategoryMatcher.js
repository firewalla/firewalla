/*    Copyright 2021 Firewalla INC
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

const log = require('../net2/logger.js')(__filename);

const CategoryUpdater = require('../control/CategoryUpdater');
const categoryUpdater = new CategoryUpdater();

const { Address4, Address6 } = require('ip-address');
const _ = require('lodash');

const firewalla = require('../net2/Firewalla');
class CategoryMatcher {
  static async newCategoryMatcher(category) {
    if (firewalla.isMain()) {
      await categoryUpdater.activateCategory(category);
    }
    const domains = await categoryUpdater.getDomains(category);
    const strategy = await categoryUpdater.getStrategy(category);

    let defaultDomains;
    if (strategy.exception.useHitSet) {
      defaultDomains = await categoryUpdater.getHitDomains(category);
    } else {
      defaultDomains = await categoryUpdater.getDefaultDomains(category);
    }

    const defaultDomainsOnly = await categoryUpdater.getDefaultDomainsOnly(category);
    const includedDomains = await categoryUpdater.getIncludedDomains(category);
    const excludedDomains = await categoryUpdater.getExcludedDomains(category);
    const defaultHashedDomains = await categoryUpdater.getDefaultHashedDomains(category);
    const ipv4Addresses = await categoryUpdater.getIPv4Addresses(category);
    const ipv6Addresses = await categoryUpdater.getIPv6Addresses(category);

    let namedDomains = _.union(domains, defaultDomains, defaultDomainsOnly, includedDomains);
    namedDomains = _.difference(namedDomains, excludedDomains);
    const domainSet = new Set(namedDomains);
    const hashedDomainSet = new Set(defaultHashedDomains);

    const ipv4Subnets = ipv4Addresses.map(addr => new Address4(addr));
    const ipv6Subnets = ipv6Addresses.map(addr => new Address6(addr));
    return new CategoryMatcher(domainSet, hashedDomainSet, ipv4Subnets, ipv6Subnets);

  }
  constructor(domain, hashed, ipv4, ipv6) {
    this.domainSet = domain;
    this.hashedDomainSet = hashed;
    this.ipv4Subnets = ipv4;
    this.ipv6Subnets = ipv6;
  }

  matchIP(s) {
    const addr4 = new Address4(s);
    if (addr4.isValid()) {
      return _.some(this.ipv4Subnets, subnet => addr4.isInSubnet(subnet));
    }

    const addr6 = new Address6(s);
    if (addr6.isValid()) {
      return _.some(this.ipv6Subnets, subnet => addr6.isInSubnet(subnet));
    }
    return false;
  }

  matchDomain(s) {
    if (this.domainSet.has(s)) {
      return true;
    }
    const tokens = s.split(".");
    for (let i = 0; i < tokens.length - 1; i++) {
      const toMatchPattern = "*." + tokens.slice(i).join(".");
      if (this.domainSet.has(toMatchPattern)) {
        return true;
      }
    }
    return false;
    //TODO add hashed domain match
  }
}

module.exports = CategoryMatcher;