/*    Copyright 2016-2026 Firewalla Inc.
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
const Ipset = require('../net2/Ipset.js')
const tlsc = require('./TLSSetControl.js');

const domainBlock = require('../control/DomainBlock.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const firewalla = require("../net2/Firewalla.js");
const { CategoryEntry } = require("./CategoryEntry.js");
const dnsmasq = new DNSMASQ();

const redirectHttpPort = 8880;
const redirectHttpsPort = 8883;
const blackHoleHttpPort = 8881;
const blackHoleHttpsPort = 8884;

// this allows biggest v4 regional set (US) being fully added,
// for v6, we need a dynamic approach for ipset management
//
// takes up to 30M memory
//
// Name: test
// Type: hash:net
// Revision: 6
// Header: family inet hashsize 524288 maxelem 1048576
// Size in memory: 30811224
// References: 0
// Number of entries: 1048576
const IPSET_HASH_MAXELEM = 1048576 // 2^20

class CategoryUpdaterBase {

  getCategoryKey(category) {
    return `dynamicCategoryDomain:${category}`
  }

  getCategorySigDtSvrKey(category) {
    return `category:${category}:sigDetectedServers`
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

  getPatternDomainsKey(pattern) {
    return `domain:pattern:${pattern}`;
  }

  getIncludedElementsKey(category) {
    return `category:${category}:included:elements`;
  }

  isDomainPattern(domain) {
    return (domain.startsWith("*.") ? domain.substring(2) : domain).includes("*");
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

  shortString(category) {
    return category.length >= 13 ? `${category.substring(0, 10)}${category.substring(category.length - 3)}` : category;
  }

  // combine prefix and suffix to form the ipset name, some ipsets may have same prefix, e.g., xxx and xxx_bf
  getAllowIPSetName(category) {
    return Block.getDstSet(this.shortString(category) + "_alw");
  }

  getAllowIPSetNameForIPV6(category) {
    return Block.getDstSet6(this.shortString(category) + "_alw");
  }

  getAggrIPSetName(category, isStatic = false) {
    return Block.getDstSet(this.shortString(category) + (isStatic ? "_sag" : "_ag"));
  }

  getAggrIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(this.shortString(category) + (isStatic ? "_sag" : "_ag"));
  }

  getNetPortIPSetName(category) {
    return Block.getDstSet(this.shortString(category) + "_np"); // bare net:port
  }

  getNetPortIPSetNameForIPV6(category) {
    return Block.getDstSet6(this.shortString(category) + "_np");
  }

  getDomainPortIPSetName(category, isStatic = false) {
    return Block.getDstSet(this.shortString(category) + (isStatic ? "_sdp" : "_ddp")); // domain-mapped ip:port, static or dynamic
  }

  getDomainPortIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(this.shortString(category) + (isStatic ? "_sdp" : "_ddp"));
  }

  getIPSetName(category, isStatic = false, isIP6 = false, isTmp = false) {
    return Block.getDstSet((isTmp ? 'tmp_' : '') + this.shortString(category) + (isStatic ? "_ip" : "_dm"), isIP6);
  }

  getIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(this.shortString(category) + (isStatic ? "_ip" : "_dm"));
  }

  getConnectionIPSetName(category) {
    return Block.getConnSet(`${this.shortString(category)}`);
  }

  getConnectionIPSetNameForIPV6(category) {
    return Block.getConnSet6(`${this.shortString(category)}`);
  }

  getTempIPSetName(category, isStatic = false) {
    return Block.getDstSet(`tmp_${this.shortString(category)}` + (isStatic ? "_ip" : "_dm"));
  }

  getTempIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(`tmp_${this.shortString(category)}` + (isStatic ? "_ip" : "_dm"));
  }

  getTempNetPortIPSetName(category) {
    return Block.getDstSet(`tmp_${this.shortString(category)}` + "_np");
  }

  getTempNetPortIPSetNameForIPV6(category) {
    return Block.getDstSet6(`tmp_${this.shortString(category)}` + "_np");
  }

  getTempDomainPortIPSetName(category, isStatic = false) {
    return Block.getDstSet(`tmp_${this.shortString(category)}` + (isStatic ? "_sdp" : "_ddp"));
  }

  getTempDomainPortIPSetNameForIPV6(category, isStatic = false) {
    return Block.getDstSet6(`tmp_${this.shortString(category)}` + (isStatic ? "_sdp" : "_ddp"));
  }

  // add entries from category:{category}:ip:domain to ipset
  async updateIpset(category, ip6 = false, options) {
    let ipsetName = this.getIPSetName(category, true, ip6);

    const categoryIps = ip6 ? await this.getIPv6Addresses(category) : await this.getIPv4Addresses(category);
    Ipset.flush(ipsetName);

    if (categoryIps.length == 0) return;
    
    categoryIps.forEach(ip => Ipset.add(ipsetName, ip, { comment: options.comment }));
  }

  // add entries from category:{category}:ip:domain to ipset
  async updateNetportIpset(category, ip6 = false, options) {
    const ipsetName = ip6 ? this.getNetPortIPSetNameForIPV6(category) : this.getNetPortIPSetName(category);
  
    const categoryIps = ip6 ? await this.getIPv6AddressesWithPort(category) : await this.getIPv4AddressesWithPort(category);
    Ipset.flush(ipsetName);

    if (categoryIps.length === 0) return;
    categoryIps.forEach(ipObj =>
      Ipset.add(ipsetName, `${ipObj.id},${CategoryEntry.toPortStr(ipObj.port)}`, { comment: options.comment })
    )
  }

  async updatePersistentIPSets(category, ip6 = false, options) {
    if (this.isActivated(category)) {
      await this.updateIpset(category, ip6, options);
      await this.updateNetportIpset(category, ip6, options);
    }
  }

  async recycleIPSet(category) { }

  // rebuild hash ipset with max size
  // make sure ipset is not referenced before calling this
  async rebuildIpset(category, ip6 = false, options) {
    const ipsetName = this.getIPSetName(category, false, ip6, options.useTemp)
    log.info(`Rebuild ipset for ${ipsetName}, size: ${options.count}`)
    await Ipset.destroy(ipsetName)
    let maxelem = options.count
    if (maxelem > IPSET_HASH_MAXELEM) {
      log.error('ipset too large:', ipsetName, maxelem, 'trunc to', IPSET_HASH_MAXELEM)
      maxelem = IPSET_HASH_MAXELEM
    } else {
      // lowest power of 2 but bigger or equal to count
      maxelem = 2 ** Math.ceil(Math.log2(maxelem))
    }
    await Ipset.create(ipsetName, 'hash:net', ip6, {
      // From ipset manual:
      // The hash size must be a power of two, the kernel automatically rounds up
      // non power of two hash sizes to the first correct value
      //
      // seems that the kernel is keeping hashsize bigger than a quarter of element count
      hashsize: maxelem / 4,
      maxelem,
    });
  }

  async swapIpset(category, isCountry = false) {
    // only dymanic net, and static/dynamic domain:port sets are swapped here
    const ipsetName = this.getIPSetName(category);
    const ipset6Name = this.getIPSetNameForIPV6(category);
    const tmpIPSetName = this.getTempIPSetName(category);
    const tmpIPSet6Name = this.getTempIPSetNameForIPV6(category);

    // swap temp ipset with ipset
    Ipset.swap(ipsetName, tmpIPSetName);
    Ipset.swap(ipset6Name, tmpIPSet6Name);

    Ipset.flush(tmpIPSetName);
    Ipset.flush(tmpIPSet6Name);

    if (!isCountry) { // country does not have following ipsets, this can greatly save kernel memory usage
      const domainportIpsetName = this.getDomainPortIPSetName(category);
      const domainportIpset6Name = this.getDomainPortIPSetNameForIPV6(category);
      const tmpDomainportIpsetName = this.getTempDomainPortIPSetName(category);
      const tmpDomainportIpset6Name = this.getTempDomainPortIPSetNameForIPV6(category);

      const staticDomainportIpsetName = this.getDomainPortIPSetName(category, true);
      const staticDomainportIpset6Name = this.getDomainPortIPSetNameForIPV6(category, true);
      const tmpStaticDomainportIpsetName = this.getTempDomainPortIPSetName(category, true);
      const tmpStaticDomainportIpset6Name = this.getTempDomainPortIPSetNameForIPV6(category, true);

      Ipset.swap(domainportIpsetName, tmpDomainportIpsetName);
      Ipset.swap(domainportIpset6Name, tmpDomainportIpset6Name);

      Ipset.swap(staticDomainportIpsetName, tmpStaticDomainportIpsetName);
      Ipset.swap(staticDomainportIpset6Name, tmpStaticDomainportIpset6Name);

      Ipset.flush(tmpDomainportIpsetName);
      Ipset.flush(tmpDomainportIpset6Name);

      Ipset.flush(tmpStaticDomainportIpsetName);
      Ipset.flush(tmpStaticDomainportIpset6Name);
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

  isTLSActivatedTCP(category) {
    const tlsHostSet = Block.getTLSHostSet(category);
    return tlsc.isSetActiveTCP(tlsHostSet);
  }

  isTLSActivatedUDP(category) {
    const tlsHostSet = Block.getTLSHostSet(category);
    return tlsc.isSetActiveUDP(tlsHostSet);
  }

  isTLSActivated(category, proto = '') {
    const tlsHostSet = Block.getTLSHostSet(category);
    return tlsc.isSetActive(tlsHostSet, proto);
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

  static getCategoryHashsetMapping() {
    return {
      "games": "app.gaming",
      "games_bf": "app.games_bf",
      "social": "app.social",
      "social_bf": "app.social_bf",
      "av": "app.video",
      "av_bf": "app.av_bf",
      "porn": "app.porn",  // dnsmasq redirect to blue hole if porn
      "porn_bf": "app.porn_bf",
      "gamble": "app.gamble",
      "gamble_bf": "app.gamble_bf",
      "shopping": "app.shopping",
      "shopping_bf": "app.shopping_bf",
      "p2p": "app.p2p",
      "p2p_bf": "app.p2p_bf",
      "vpn": "app.vpn",
      "vpn_bf": "app.vpn_bf"
    }
  }
}

module.exports = CategoryUpdaterBase
