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
const fc = require('../net2/config.js')

const rclient = require('../util/redis_manager.js').getRedisClient()

const Block = require('./Block.js');

const exec = require('child-process-promise').exec

const wrapIptables = require('../net2/Iptables.js').wrapIptables;
const domainBlock = require('../control/DomainBlock.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const redirectHttpPort = 8880;
const redirectHttpsPort = 8883;
const blackHoleHttpPort = 8881;
const blackHoleHttpsPort = 8884;
const blockHttpPort = 8882;
const blockHttpsPort = 8885;

class CategoryUpdaterBase {

  getCategoryKey(category) {
    return `dynamicCategoryDomain:${category}`
  }

  getExcludeCategoryKey(category) {
    return `category:${category}:exclude:domain`
  }

  getIncludeCategoryKey(category) {
    return `category:${category}:include:domain`
  }

  getDefaultCategoryKey(category) {
    return `category:${category}:default:domain`
  }

  getDefaultCategoryKeyOnly(category) {
    return `category:${category}:default:domainonly`
  }

  getDefaultCategoryKeyHashed(category) {
    return `category:${category}:default:domainhashed`
  }

  getHitCategoryKey(category) {
    return `category:${category}:hit:domain`;
  }

  getPassthroughCategoryKey(category) {
    return `category:${category}:passthrough:domain`;
  }

  getCategoryStrategyKey(category) {
    return `category:${category}:strategy`;
  }

  // this key could be used to store domain, ip, or subnet
  getIPv4CategoryKey(category) {
    return `category:${category}:ip4:domain`
  }

  getIPv6CategoryKey(category) {
    return `category:${category}:ip6:domain`
  }

  async getIPv4Addresses(category) {

    return rclient.smembersAsync(this.getIPv4CategoryKey(category))
  }

  async getIPv4AddressesCount(category) {

    return rclient.scardAsync(this.getIPv4CategoryKey(category))
  }

  async addIPv4Addresses(category, addresses) {
    if (!category || !Array.isArray(addresses) || addresses.length === 0) {
      return
    }

    let args = [this.getIPv4CategoryKey(category)]

    args.push.apply(args, addresses)
    return rclient.saddAsync(args)
  }

  async flushIPv4Addresses(category) {
    return rclient.unlinkAsync(this.getIPv4CategoryKey(category));
  }

  async getIPv6Addresses(category) {
    return rclient.smembersAsync(this.getIPv6CategoryKey(category))
  }

  async getIPv6AddressesCount(category) {
    return rclient.scardAsync(this.getIPv6CategoryKey(category))
  }

  async addIPv6Addresses(category, addresses) {
    if (!category || !Array.isArray(addresses) || addresses.length === 0) {
      return
    }

    let commands = [this.getIPv6CategoryKey(category)]

    commands.push.apply(commands, addresses)
    return rclient.saddAsync(commands)
  }

  async flushIPv6Addresses(category) {
    return rclient.unlinkAsync(this.getIPv6CategoryKey(category));
  }

  getHostSetName(category) {
    // substring(0,13) is only for ipset name length limitation, no need for same logic for tls
    return Block.getTLSHostSet(category);
  }

  getIPSetName(category, isStatic = false) {
    return Block.getDstSet(category.substring(0, 13) + (isStatic ? "_sta" : ""));
  }

  getIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(category.substring(0, 13) + (isStatic ? "_sta" : ""));
  }

  getTempIPSetName(category, isStatic = false) {
    return Block.getDstSet(`tmp_${category.substring(0, 13)}` + (isStatic ? "_sta" : ""));
  }

  getTempIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(`tmp_${category.substring(0, 13)}` + (isStatic ? "_sta" : ""));
  }

  // add entries from category:{category}:ip:domain to ipset
  async updateIpset(category, ip6 = false, options) {
    const key = ip6 ? this.getIPv6CategoryKey(category) : this.getIPv4CategoryKey(category)

    let ipsetName = ip6 ? this.getIPSetNameForIPV6(category) : this.getIPSetName(category)
    let staticIpsetName = ip6 ? this.getIPSetNameForIPV6(category, true) : this.getIPSetName(category, true);

    if (options && options.useTemp) {
      ipsetName = ip6 ? this.getTempIPSetNameForIPV6(category) : this.getTempIPSetName(category)
      staticIpsetName = ip6 ? this.getTempIPSetNameForIPV6(category, true) : this.getTempIPSetName(category, true);
    }
    const categoryIps = await rclient.smembersAsync(key);
    if (categoryIps.length == 0) return;
    let cmd4 = `echo "${categoryIps.join('\n')}" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
    await exec(cmd4).catch((err) => {
      log.error(`Failed to update ipset by ${category} with ip${ip6 ? 6 : 4} addresses`, err);
    })
    cmd4 = `echo "${categoryIps.join('\n')}" | sed 's=^=add ${staticIpsetName} = ' | sudo ipset restore -!`;
    await exec(cmd4).catch((err) => {
      log.error(`Failed to update static ipset by ${category} with ip${ip6 ? 6 : 4} addresses`, err);
    });
  }

  async updatePersistentIPSets(category, options) {
    if (this.isActivated(category)) {
      await this.updateIpset(category, false, options)
      await this.updateIpset(category, true, options)
    }
  }

  async recycleIPSet(category) { }

  async swapIpset(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)
    const tmpIPSetName = this.getTempIPSetName(category)
    const tmpIPSet6Name = this.getTempIPSetNameForIPV6(category)

    const staticIpsetName = this.getIPSetName(category, true);
    const staticIpset6Name = this.getIPSetNameForIPV6(category, true);
    const tmpStaticIPSetName = this.getTempIPSetName(category, true);
    const tmpStaticIPSet6Name = this.getTempIPSetNameForIPV6(category, true);

    // swap temp ipset with ipset
    const swapCmd = `sudo ipset swap ${ipsetName} ${tmpIPSetName}`
    const swapCmd6 = `sudo ipset swap ${ipset6Name} ${tmpIPSet6Name}`

    const swapStaticCmd = `sudo ipset swap ${staticIpsetName} ${tmpStaticIPSetName}`;
    const swapStaticCmd6 = `sudo ipset swap ${staticIpset6Name} ${tmpStaticIPSet6Name}`;

    await exec(swapCmd).catch((err) => {
      log.error(`Failed to swap ipsets for category ${category}`, err)
    })

    await exec(swapCmd6).catch((err) => {
      log.error(`Failed to swap ipsets6 for category ${category}`, err)
    })

    await exec(swapStaticCmd).catch((err) => {
      log.error(`Failed to swap static ipsets for category ${category}`, err)
    });

    await exec(swapStaticCmd6).catch((err) => {
      log.error(`Failed to swap static ipsets6 for category ${category}`, err)
    });

    const flushCmd = `sudo ipset flush ${tmpIPSetName}`
    const flushCmd6 = `sudo ipset flush ${tmpIPSet6Name}`

    const flushStaticCmd = `sudo ipset flush ${tmpStaticIPSetName}`;
    const flushStaticCmd6 = `sudo ipset flush ${tmpStaticIPSet6Name}`;

    await exec(flushCmd).catch((err) => {
      log.error(`Failed to flush temp ipsets for category ${category}`, err)
    })

    await exec(flushCmd6).catch((err) => {
      log.error(`Failed to flush temp ipsets6 for category ${category}`, err)
    })

    await exec(flushStaticCmd).catch((err) => {
      log.error(`Failed to flush temp static ipsets for category ${category}`, err)
    })

    await exec(flushStaticCmd6).catch((err) => {
      log.error(`Failed to flush temp static ipsets6 for category ${category}`, err)
    })
  }

  async deleteCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    return rclient.unlinkAsync(key)
  }

  getActiveCategories() {
    return Object.keys(this.activeCategories)
  }

  async activateCategory(category, type = 'hash:ip') {
    // since there is only a limited number of category ipsets, it is acceptable to assign a larger hash size for these ipsets for better performance
    await Block.setupCategoryEnv(category, type, 4096);

    await dnsmasq.createCategoryMappingFile(category, [this.getIPSetName(category), `${this.getIPSetNameForIPV6(category)}`]);
    dnsmasq.scheduleRestartDNSService();
    this.activeCategories[category] = 1
  }

  async deactivateCategory(category) {
    delete this.activeCategories[category]
    await this.deleteCategoryRecord(category)
  }

  isActivated(category) {
    // always return true for now
    return this.activeCategories[category] !== undefined
  }

  isTLSActivated(category) {
    return this.activeTLSCategories && this.activeTLSCategories[category] !== undefined
  }

  async refreshCategoryRecord(category) { }

  async refreshAllCategoryRecords() {
    log.info("============= UPDATING CATEGORY IPSET =============")
    const categories = this.getActiveCategories()
    log.info('Active categories', categories)

    for (const category of categories) {
      await this.refreshCategoryRecord(category).catch((err) => {
        log.error(`Failed to refresh category ${category}`, err)
      }) // refresh domain list for each category

      await domainBlock.updateCategoryBlock(category).catch((err) => {
        log.error(`Failed to update category domain mapping of ${category} in dnsmasq`, err.message);
      });

      await this.recycleIPSet(category).catch((err) => {
        log.error(`Failed to recycle ipset for category ${category}`, err)
      }) // sync refreshed domain list to ipset
    }
    log.info("============= UPDATING CATEGORY IPSET COMPLETE =============")
  }

  getHttpPort(category) {
    if (category === 'default_c') {
      return blackHoleHttpPort;
    } else {
      return redirectHttpPort;
    }
  }

  getHttpsPort(category) {
    if (category === 'default_c') {
      return blackHoleHttpsPort;
    } else {
      return redirectHttpsPort;
    }
  }

  async iptablesRedirectCategory(category) {
    try {
      const ipsetName = this.getIPSetName(category)
      const ipset6Name = this.getIPSetNameForIPV6(category)

      const cmdRedirectHTTPRule = wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
      const cmdRedirectHTTPSRule = wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)
      const cmdRedirectHTTPRule6 = wrapIptables(`sudo ip6tables -w -t nat -I FW_PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
      const cmdRedirectHTTPSRule6 = wrapIptables(`sudo ip6tables -w -t nat -I FW_PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)

      await exec(cmdRedirectHTTPRule)
      await exec(cmdRedirectHTTPSRule)
      await exec(cmdRedirectHTTPRule6)
      await exec(cmdRedirectHTTPSRule6)
    } catch (err) {
      log.error("Failed to redirect", category, "traffic", err)
    }
  }

  async iptablesUnredirectCategory(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdRedirectHTTPRule = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
    const cmdRedirectHTTPSRule = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)
    const cmdRedirectHTTPRule6 = wrapIptables(`sudo ip6tables -w -t nat -D FW_PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`)
    const cmdRedirectHTTPSRule6 = wrapIptables(`sudo ip6tables -w -t nat -D FW_PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`)

    await exec(cmdRedirectHTTPRule)
    await exec(cmdRedirectHTTPSRule)
    await exec(cmdRedirectHTTPRule6)
    await exec(cmdRedirectHTTPSRule6)
  }
}

module.exports = CategoryUpdaterBase
