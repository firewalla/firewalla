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

const minimatch = require('minimatch');

const { Address4, Address6 } = require('ip-address');
const _ = require('lodash');

class CategoryMatcher {
    static async newCategoryMatcher(category) {
        await categoryUpdater.activateCategory(category);
        const domains = await categoryUpdater.getDomains(category);
        const defaultDomains = await categoryUpdater.getDefaultDomains(category);
        const defaultDomainsOnly = await categoryUpdater.getDefaultDomainsOnly(category);
        const includedDomains = await categoryUpdater.getIncludedDomains(category);
        const excludedDomains = await categoryUpdater.getExcludedDomains(category);
        const defaultHashedDomains = await categoryUpdater.getDefaultHashedDomains(category);
        const ipv4Addresses = await categoryUpdater.getIPv4Addresses(category);
        const ipv6Addresses = await categoryUpdater.getIPv6Addresses(category);

        let namedDomains = _.union(domains, defaultDomains, defaultDomainsOnly, includedDomains);
        namedDomains = _.difference(namedDomains, excludedDomains);
        const exactDomainSet = new Set(namedDomains.filter(d => !d.startsWith("*.")));
        const hashedDomainSet = new Set(defaultHashedDomains);
        const wildcardDomains = namedDomains.filter(d => d.startsWith("*."));
        const ipv4Subnets = ipv4Addresses.map(addr => new Address4(addr));
        const ipv6Subnets = ipv6Addresses.map(addr => new Address6(addr));
        return new CategoryMatcher(exactDomainSet, hashedDomainSet, wildcardDomains, ipv4Subnets, ipv6Subnets);

    }
    constructor(exact, hashed, wildcard, ipv4, ipv6) {
        this.exactDomainSet = exact;
        this.hashedDomainSet = hashed;
        this.wildcardDomains = wildcard;
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
        if (this.exactDomainSet.has(s)) {
            return true;
        }

        for (const wildcardDomain of this.wildcardDomains) {
            if (wildcardDomain.substr(2) === s) {
                return true;
            }
            if (minimatch(s, wildcardDomain)) {
                return true;
            }
        }

        //TODO add hashed domain match

        return false;
    }
}

module.exports = CategoryMatcher;