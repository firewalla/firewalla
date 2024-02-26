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

const exec = require('child-process-promise').exec;

const wrapIptables = require('../net2/Iptables.js').wrapIptables;
const domainBlock = require('../control/DomainBlock.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const firewalla = require("../net2/Firewalla.js");
const { CategoryEntry } = require("./CategoryEntry.js");
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

  getCategoryDataListKey(category) {
    return `category:${category}:data`;
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

  async getIPv4AddressesWithPort(category) {
    return [];
  }

  async getIPv6AddressesWithPort(category) {
    return [];
  }

  getHostSetName(category) {
    // substring(0,13) is only for ipset name length limitation, no need for same logic for tls
    return Block.getTLSHostSet(category);
  }

  getAllowIPSetName(category) {
    return Block.getDstSet(category.substring(0, 13) + "_alw");
  }

  getAllowIPSetNameForIPV6(category) {
    return Block.getDstSet6(category.substring(0, 13) + "_alw");
  }

  getAggrIPSetName(category, isStatic = false) {
    return Block.getDstSet(category.substring(0, 13) + (isStatic ? "_sag" : "_ag"));
  }

  getAggrIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(category.substring(0, 13) + (isStatic ? "_sag" : "_ag"));
  }

  getNetPortIPSetName(category) {
    return Block.getDstSet(category.substring(0, 13) + "_np"); // bare net:port
  }

  getNetPortIPSetNameForIPV6(category) {
    return Block.getDstSet6(category.substring(0, 13) + "_np");
  }

  getDomainPortIPSetName(category, isStatic = false) {
    return Block.getDstSet(category.substring(0, 13) + (isStatic ? "_sdp" : "_ddp")); // domain-mapped ip:port, static or dynamic
  }

  getDomainPortIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(category.substring(0, 13) + (isStatic ? "_sdp" : "_ddp"));
  }

  getIPSetName(category, isStatic = false) {
    return Block.getDstSet(category.substring(0, 13) + (isStatic ? "_ip" : "_dm"));
  }

  getIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(category.substring(0, 13) + (isStatic ? "_ip" : "_dm"));
  }

  getTempIPSetName(category, isStatic = false) {
    return Block.getDstSet(`tmp_${category.substring(0, 13)}` + (isStatic ? "_ip" : "_dm"));
  }

  getTempIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(`tmp_${category.substring(0, 13)}` + (isStatic ? "_ip" : "_dm"));
  }

  getTempNetPortIPSetName(category) {
    return Block.getDstSet(`tmp_${category.substring(0, 13)}` + "_np");
  }

  getTempNetPortIPSetNameForIPV6(category) {
    return Block.getDstSet6(`tmp_${category.substring(0, 13)}` + "_np");
  }

  getTempDomainPortIPSetName(category, isStatic = false) {
    return Block.getDstSet(`tmp_${category.substring(0, 13)}` + (isStatic ? "_sdp" : "_ddp"));
  }

  getTempDomainPortIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(`tmp_${category.substring(0, 13)}` + (isStatic ? "_sdp" : "_ddp"));
  }

  // add entries from category:{category}:ip:domain to ipset
  async updateIpset(category, ip6 = false, options) {
    let ipsetName = ip6 ? this.getIPSetNameForIPV6(category, true) : this.getIPSetName(category, true);

    const categoryIps = ip6 ? await this.getIPv6Addresses(category) : await this.getIPv4Addresses(category);
    await exec(`sudo ipset flush ${ipsetName}`).catch((err) => {});

    if (categoryIps.length == 0) return;
    let input = categoryIps.join('\n');
    let cmd = `sed 's=^=add ${ipsetName} = '`;
    if (options.comment) {
      cmd += `| sed 's=$= comment ${options.comment}=' `;
    }
    cmd += `| sudo ipset restore -!`;
    let command = exec(cmd);
    command.childProcess.stdin.write(input);
    command.childProcess.stdin.end();

    await command.catch((err) => {
      log.error(`Failed to update ipset by ${category} with ip${ip6 ? 6 : 4} addresses`, err);
    });
  }

  // add entries from category:{category}:ip:domain to ipset
  async updateNetportIpset(category, ip6 = false, options) {
    let ipsetName = ip6 ? this.getNetPortIPSetNameForIPV6(category) : this.getNetPortIPSetName(category)

    const categoryIps = ip6 ? await this.getIPv6AddressesWithPort(category) : await this.getIPv4AddressesWithPort(category);
    await exec(`sudo ipset flush ${ipsetName}`).catch((err) => {});

    if (categoryIps.length == 0) return;
    const entryList = [];
    for (const ipObj of categoryIps) {
      const ip = ipObj.id;
      entryList.push(`${ip},${CategoryEntry.toPortStr(ipObj.port)}`);
    }
    let cmd = `echo "${entryList.join('\n')}" | sed 's=^=add ${ipsetName} = '`;
    if (options.comment) {
      cmd += `| sed 's=$= comment ${options.comment}=' `;
    }
    cmd += `| sudo ipset restore -!`;
    await exec(cmd).catch((err) => {
      log.error(`Failed to update ipset by ${category} with ip${ip6 ? 6 : 4} addresses`, err);
    });
  }

  async updatePersistentIPSets(category, options) {
    if (this.isActivated(category)) {
      await this.updateIpset(category, false, options);
      await this.updateIpset(category, true, options);
      await this.updateNetportIpset(category, false, options);
      await this.updateNetportIpset(category, true, options);
    }
  }

  async recycleIPSet(category) { }

  async swapIpset(category, isCountry = false) {
    // only dymanic net, and static/dynamic domain:port sets are swapped here
    const ipsetName = this.getIPSetName(category);
    const ipset6Name = this.getIPSetNameForIPV6(category);
    const tmpIPSetName = this.getTempIPSetName(category);
    const tmpIPSet6Name = this.getTempIPSetNameForIPV6(category);

    // swap temp ipset with ipset
    const swapCmd = `sudo ipset swap ${ipsetName} ${tmpIPSetName}`;
    const swapCmd6 = `sudo ipset swap ${ipset6Name} ${tmpIPSet6Name}`;
    await exec(swapCmd).catch((err) => {
      log.error(`Failed to swap ipsets for category ${category}`, err);
    });

    await exec(swapCmd6).catch((err) => {
      log.error(`Failed to swap ipsets6 for category ${category}`, err);
    });

    const flushCmd = `sudo ipset flush ${tmpIPSetName}`;
    const flushCmd6 = `sudo ipset flush ${tmpIPSet6Name}`;
    await exec(flushCmd).catch((err) => {
      log.error(`Failed to flush temp ipsets for category ${category}`, err);
    });

    await exec(flushCmd6).catch((err) => {
      log.error(`Failed to flush temp ipsets6 for category ${category}`, err);
    });

    if (!isCountry) { // country does not have following ipsets, this can greatly save kernel memory usage
      const domainportIpsetName = this.getDomainPortIPSetName(category);
      const domainportIpset6Name = this.getDomainPortIPSetNameForIPV6(category);
      const tmpDomainportIpsetName = this.getTempDomainPortIPSetName(category);
      const tmpDomainportIpset6Name = this.getTempDomainPortIPSetNameForIPV6(category);
  
      const staticDomainportIpsetName = this.getDomainPortIPSetName(category, true);
      const staticDomainportIpset6Name = this.getDomainPortIPSetNameForIPV6(category, true);
      const tmpStaticDomainportIpsetName = this.getTempDomainPortIPSetName(category, true);
      const tmpStaticDomainportIpset6Name = this.getTempDomainPortIPSetNameForIPV6(category, true);
  
      const swapDomainportCmd = `sudo ipset swap ${domainportIpsetName} ${tmpDomainportIpsetName}`;
      const swapDomainportCmd6 = `sudo ipset swap ${domainportIpset6Name} ${tmpDomainportIpset6Name}`;
  
      const swapStaticDomainportCmd = `sudo ipset swap ${staticDomainportIpsetName} ${tmpStaticDomainportIpsetName}`;
      const swapStaticDomainportCmd6 = `sudo ipset swap ${staticDomainportIpset6Name} ${tmpStaticDomainportIpset6Name}`;
  
      await exec(swapDomainportCmd).catch((err) => {
        log.error(`Failed to swap netport ipsets for category ${category}`, err);
      });
  
      await exec(swapDomainportCmd6).catch((err) => {
        log.error(`Failed to swap netport ipsets6 for category ${category}`, err);
      });
  
      await exec(swapStaticDomainportCmd).catch((err) => {
        log.error(`Failed to swap static netport ipsets for category ${category}`, err);
      });
  
      await exec(swapStaticDomainportCmd6).catch((err) => {
        log.error(`Failed to swap static netport ipsets6 for category ${category}`, err);
      });
  
      const flushDomainportCmd = `sudo ipset flush ${tmpDomainportIpsetName}`;
      const flushDomainportCmd6 = `sudo ipset flush ${tmpDomainportIpset6Name}`;
  
      const flushStaticDomainportCmd = `sudo ipset flush ${tmpStaticDomainportIpsetName}`;
      const flushStaticDomainportCmd6 = `sudo ipset flush ${tmpStaticDomainportIpset6Name}`;
  
      await exec(flushDomainportCmd).catch((err) => {
        log.error(`Failed to flush temp netport ipsets for category ${category}`, err);
      });
  
      await exec(flushDomainportCmd6).catch((err) => {
        log.error(`Failed to flush temp netport ipsets6 for category ${category}`, err);
      });
  
      await exec(flushStaticDomainportCmd).catch((err) => {
        log.error(`Failed to flush temp static netport ipsets for category ${category}`, err);
      });
  
      await exec(flushStaticDomainportCmd6).catch((err) => {
        log.error(`Failed to flush temp static netport ipsets6 for category ${category}`, err);
      });
    }
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
    const needComment = this.needIpSetComment(category);

    await Block.setupCategoryEnv(category, type, 4096, needComment);

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

  // user defined target list on cloud, may include port, protocol
  isUserTargetList(category) {
    return category.startsWith("TL-");
  }

  // system extended small target list, may include port, protocol, but not many entries, no need to use cloud cache
  isSmallExtendedTargetList(category) {
    return category.startsWith("TLX-");
  }

  needIpSetComment(category) {
    const release = firewalla.getReleaseType();
    return this.isUserTargetList(category) && ["dev", "unknown"].includes(release);
  }
}

module.exports = CategoryUpdaterBase
