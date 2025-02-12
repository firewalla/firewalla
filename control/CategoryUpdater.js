/*    Copyright 2016-2023 Firewalla Inc.
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

const firewalla = require("../net2/Firewalla.js");

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const CategoryUpdaterBase = require('./CategoryUpdaterBase.js');
const domainBlock = require('../control/DomainBlock.js');
const Block = require('../control/Block.js');
const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()
const { eachLimit } = require('../util/asyncNative.js')
const DomainTrie = require('../util/DomainTrie.js');

const exec = require('child-process-promise').exec
const { Address4, Address6 } = require('ip-address');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const _ = require('lodash');
const fc = require('../net2/config.js');
const scheduler = require('../util/scheduler');
let instance = null

const EXPIRE_TIME = 60 * 60 * 24 * 5 // five days...
const CUSTOMIZED_CATEGORY_KEY_PREFIX = "customized_category:id:"

const CATEGORY_FILTER_DIR = "/home/pi/.firewalla/run/category_data/filters";
const crypto = require('crypto');
const { CategoryEntry } = require("./CategoryEntry.js");

const net = require('net')

const hashFunc = function (obj) {
  const str = JSON.stringify(obj);
  return crypto.createHash("md5").update(str).digest("base64");
};
class CategoryUpdater extends CategoryUpdaterBase {

  constructor() {
    if (instance == null) {
      super()
      this.inited = false;
      instance = this

      this.resetUpdaterState()

      this.recycleTasks = {};

      this.excludedDomains = {
        "av": [
          "www.google.com",
          "forcesafesearch.google.com",
          "docs.google.com",
          "*.itunes.apple.com",
          "itunes.apple.com"
        ]
      };

      this.excludeListBundleIds = new Set(["default_c", "adblock_strict", "games", "social", "av", "porn", "gamble", "p2p", "vpn", "shopping"]);

      this.refreshCustomizedCategories();

      sem.on("CustomizedCategory:Updated", async () => {
        if (firewalla.isMain()) {
          await this.refreshCustomizedCategories();
        }
      });

      if (firewalla.isMain()) {
        this.domainPatternTrie = new DomainTrie();
        this.categoryWithPattern = new Set();
        sem.on('UPDATE_CATEGORY_DOMAIN', async (event) => {
          if (!this.inited) {
            log.info("Category updater is not ready yet, will retry in 5 seconds", event.category);
            // re-emit the same event in 5 seconds if init process is not complete yet
            setTimeout(() => {
              sem.emitEvent(event);
            }, 5000);
          } else {
            if (event.category) {
              const strategy = await this.getStrategy(event.category);
              if (this.isTLSActivated(event.category) && strategy.tls.enabled) {
                domainBlock.refreshTLSCategory(event.category); // flush and recreate, could be optimized later
              }
              if (this.isActivated(event.category)) {
                try {
                  await this.refreshCategoryRecord(event.category);
                  if (strategy.dnsmasq.enabled) {
                    await domainBlock.updateCategoryBlock(event.category);
                  }
                  const patterns = _.union(await this.getDefaultDomainPatterns(event.category), await this.getIncludedDomainPatterns(event.category));
                  if (!_.isEmpty(patterns) || this.categoryWithPattern.has(event.category)) {
                    await this.rebuildDomainPatternTrie();
                    if (_.isEmpty(patterns))
                      this.categoryWithPattern.delete(event.category);
                    else
                      this.categoryWithPattern.add(event.category);
                  }
                  if (strategy.ipset.enabled) {
                    await this.recycleIPSet(event.category);
                  }
                } catch (err) {
                  log.error(`Failed to update category domain ${event.category}`, err.message);
                }
              }

              // check if category filter exists to update
              const bf_strategy = await this.getStrategy(event.category + '_bf');
              if (bf_strategy && this.isActivated(event.category + '_bf')) {
                if (bf_strategy.dnsmasq.enabled && bf_strategy.dnsmasq.useFilter)
                  sem.emitEvent({
                    type: "REFRESH_CATEGORY_FILTER",
                    message: "Refresh category fitler " + event.category + '_bf',
                    category: event.category + '_bf',
                    toProcess: "FireMain"
                  });
              };
            }
          }
        });

        sem.on('UPDATE_CATEGORY_HITSET', async (event) => {
          if (!this.inited) {
            log.info("Category updater is not ready yet, will retry in 5 seconds", event.category);
            // re-emit the same event in 5 seconds if init process is not complete yet
            setTimeout(() => {
              sem.emitEvent(event);
            }, 5000);
          } else {
            if (event.category) {
              const strategy = await this.getStrategy(event.category);

              if (this.isTLSActivated(event.category) && strategy.tls.enabled && strategy.tls.useHitSet) {
                void domainBlock.refreshTLSCategory(event.category); // flush and recreate, could be optimized later
              }
              if (this.isActivated(event.category)) {
                void (async () => {
                  try {
                    await this.refreshCategoryRecord(event.category);
                    // no need to update dnsmasq because it directly takes effect on hit set update
                    if (strategy.ipset.enabled && strategy.ipset.useHitSet) {
                      await this.recycleIPSet(event.category);
                    }
                  } catch (err) {
                    log.error(`Failed to update category domain ${event.category} on hit set update`, err.message);
                  }
                })();
              }
            }
          }
        });

        sem.once('IPTABLES_READY', async () => {
          log.info("iptables is ready");
          await this.refreshCustomizedCategories();
          setInterval(() => {
            this.refreshAllCategoryRecords()
          }, 60 * 60 * 1000 * 4) // update records every 4 hours 
          await this.refreshAllCategoryRecords()
          this.inited = true;
        })
      }
    }

    return instance
  }

  async rebuildDomainPatternTrie() {
    const trie = new DomainTrie();
    await Promise.all(Object.keys(this.activeCategories).map(async c => {
      try {
        const patterns = _.union(await this.getDefaultDomainPatterns(c), await this.getIncludedDomainPatterns(c));
        const patternsWithPort = await this.getDefaultDomainPatternsWithPort(c);
        for (const p of patterns) {
          const obj = {category: c, isStatic: false, pattern: p};
          trie.add(p, obj);
          const domains = await this.getPatternDomains(p);
          for (const d of domains)
            trie.add(d, obj);
        }
        for (const p of patternsWithPort) {
          const obj = { category: c, isStatic: true, port: p.port, pattern: p.id };
          trie.add(p.id, obj);
          const domains = await this.getPatternDomains(p.id);
          for (const d of domains)
            trie.add(d, obj);
        }
      } catch (err) {
        log.error(`Failed to add pattern matched domains of ${c} to trie`, err.message);
      }
    }));
    this.domainPatternTrie = trie;
  }

  resetUpdaterState() {
    this.effectiveCategoryDomains = {};
    this.effectiveCategoryAdresses = {};

    this.activeCategories = {
      // "default_c": 1
      // categories below should be activated on demand
      // "games": 1,
      // "social": 1,
      // "porn": 1,
      // "shopping": 1,
      // "av": 1,
      // "p2p": 1,
      // "gamble": 1,
      // "vpn": 1
    };

    this.activeTLSCategories = {}; // default_c is not preset here because hostset file is generated only if iptables rule is created.

    this.customizedCategories = {};
  }

  async refreshTLSCategoryActivated() {
    try {
      const cmdResult = await exec(`ls -l /proc/net/xt_tls/hostset |awk '{print $9}'`); //either from xt_tls or from xt_udp_tls is fine
      const results = cmdResult.stdout.toString().trim().split('\n');
      const activeCategories = Object.keys(this.activeTLSCategories).filter(c => results.includes(this.getHostSetName(c)));
      Object.keys(this.activeTLSCategories).forEach(key => {
        delete this.activeTLSCategories[key]
      });
      for (const c of activeCategories)
        this.activeTLSCategories[c] = 1;
    } catch (err) {
      log.info("Failed to get active TLS category", err);
    }
  }

  isCustomizedCategory(category) {
    if (this.customizedCategories[category])
      return true;
    return false;
  }

  _getCustomizedCategoryKey(category) {
    return `${CUSTOMIZED_CATEGORY_KEY_PREFIX}${category}`;
  }

  _getCustomizedCategoryIpsetType(category) {
    if (this.customizedCategories[category]) {
      switch (this.customizedCategories[category].type) {
        case "net":
          return "hash:net";
        case "port":
          return "bitmap:port";
        default:
          return "hash:net";
      }
    }
    return "hash:net";
  }

  async _getNextCustomizedCategory() {
    let id = await rclient.getAsync("customized_category:id");
    if (!id) {
      id = 1;
      await rclient.setAsync("customized_category:id", id);
    }
    await rclient.incrAsync("customized_category:id");
    return `cc_${id}`;
  }

  async getCustomizedCategories() {
    const result = {};
    for (const c in this.customizedCategories) {
      const elements = await this.getIncludedElements(c);
      result[c] = Object.assign({}, this.customizedCategories[c], { elements: elements });
    }
    return result;
  }

  async createOrUpdateCustomizedCategory(category, obj) {
    if (!obj || !obj.name)
      throw new Error(`name is not specified`);

    if (!category)
      category = require('uuid').v4();
    obj.category = category;
    const key = this._getCustomizedCategoryKey(category);
    await rclient.unlinkAsync(key);
    await rclient.hmsetAsync(key, obj);
    sem.emitEvent({
      type: "CustomizedCategory:Updated",
      toProcess: "FireMain"
    });
    await this.refreshCustomizedCategories();
    return this.customizedCategories[category];
  }

  async removeCustomizedCategory(category) {
    if (!category || !this.customizedCategories[category])
      return;
    const key = this._getCustomizedCategoryKey(category);
    await rclient.unlinkAsync(key);
    sem.emitEvent({
      type: "CustomizedCategory:Updated",
      toProcess: "FireMain"
    });
    await this.refreshCustomizedCategories();
  }

  async refreshCustomizedCategories() {
    try {
      for (const c in this.customizedCategories)
        this.customizedCategories[c].exists = false;

      const keys = await rclient.scanResults(`${CUSTOMIZED_CATEGORY_KEY_PREFIX}*`);
      for (const key of keys) {
        const o = await rclient.hgetallAsync(key);
        const category = key.substring(CUSTOMIZED_CATEGORY_KEY_PREFIX.length);
        log.info(`Found customized category ${category}`);
        this.customizedCategories[category] = o;
        this.customizedCategories[category].exists = true;
      }

      const removedCategories = {};
      Object.keys(this.customizedCategories).filter(c => this.customizedCategories[c].exists === false).map((c) => {
        removedCategories[c] = this.customizedCategories[c];
      });
      for (const c in removedCategories) {
        log.info(`Customized category ${c} is removed, will cleanup enforcement env ...`);
        if (firewalla.isMain()) {
          await this.flushIPv4Addresses(c);
          await this.flushIPv6Addresses(c);
          await this.flushIncludedDomains(c);
          // this will trigger ipset recycle and dnsmasq config change
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category: c,
            message: 'remove category' + c,
          };
          sem.sendEventToAll(event);
        }
        delete this.customizedCategories[c];
      }
    } catch(err) {
      log.error('Failed to refresh customized categories', err)
    }
    return this.customizedCategories;
  }

  async activateCategory(category) {
    log.debug("invoke activate category", category)
    if (this.isActivated(category)) return;
    if (firewalla.isMain()) // do not create ipset unless in FireMain
      await super.activateCategory(category, this.isCustomizedCategory(category) ? this._getCustomizedCategoryIpsetType(category) : "hash:net");
    sem.emitEvent({
      type: "Policy:CategoryActivated",
      toProcess: "FireMain",
      message: "Category activated: " + category,
      category: category
    });
  }

  async deactivateCategory(category) {
    if (!this.isActivated(category)) {
      return;
    }

    sem.emitEvent({
      type: "Category:Delete",
      toProcess: "FireMain",
      message: "Category deactivated: " + category,
      category: category
    });
  }

  async activateTLSCategory(category) {
    if (this.isTLSActivated(category)) return;
    this.activeTLSCategories[category] = 1;

    // wait for a maximum of  30 seconds for category data to be ready.
    let i = 0;
    while (i < 30) {
      if (category === "default_c") {
        break;
      }
      const categoryStrategy = await rclient.getAsync(this.getCategoryStrategyKey(category));
      if (categoryStrategy) {
        break;
      }
      await scheduler.delay(1000);
      i++;
    }
    await domainBlock.refreshTLSCategory(category);
  }

  async addPatternDomains(pattern, domain) {
    await rclient.saddAsync(this.getPatternDomainsKey(pattern), domain);
    await rclient.expireAsync(this.getPatternDomainsKey(pattern), EXPIRE_TIME);
  }

  async getPatternDomains(pattern) {
    const domains = await rclient.smembersAsync(this.getPatternDomainsKey(pattern));
    await rclient.expireAsync(this.getPatternDomainsKey(pattern), EXPIRE_TIME);
    return domains;
  }

  async getPatternMatchedDomains(category) {
    const patterns = _.union(await this.getDefaultDomainPatterns(category), await this.getIncludedDomainPatterns(category));
    const patternDomains = await Promise.all(patterns.map(pattern => this.getPatternDomains(pattern)));
    return _.uniq(patternDomains.flatMap(p => p));
  }

  async getDomains(category) {
    return rclient.zrangeAsync(this.getCategoryKey(category), 0, -1)
  }

  async categoryDataListExists(category) {
    return rclient.existsAsync(this.getCategoryDataListKey(category));
  }

  async getDefaultDomainPatterns(category) {
    if (await this.categoryDataListExists(category)) {
      return (await this.getCategoryData(category)).filter(v => (!v.tags && v.type === "domain" && !v.port && this.isDomainPattern(v.id))).map(v => v.id);
    }
    return rclient.smembersAsync(this.getDefaultCategoryKey(category)).then(results => results.filter(d => this.isDomainPattern(d)));
  }

  async getDefaultDomains(category) {
    if (await this.categoryDataListExists(category)) {
      return (await this.getCategoryData(category)).filter(v => (!v.tags && v.type === "domain" && !v.port && !this.isDomainPattern(v.id))).map(v => v.id);
    }
    return rclient.smembersAsync(this.getDefaultCategoryKey(category)).then(results => results.filter(d => !this.isDomainPattern(d)));
  }

  async getDefaultDomainsOnly(category) {
    return rclient.smembersAsync(this.getDefaultCategoryKeyOnly(category))
  }

  async getDefaultDomainPatternsWithPort(category) {
    return (await this.getCategoryData(category)).filter(v => (v.type === "domain" && v.port && !v.domainOnly && this.isDomainPattern(v.id)));
  }

  async getDefaultDomainsWithPort(category) {
    return (await this.getCategoryData(category)).filter(v => (v.type === "domain" && v.port && !v.domainOnly && !this.isDomainPattern(v.id)));
  }

  async getDefaultDomainsOnlyWithPort(category) {
    return (await this.getCategoryData(category)).filter(v => (v.type === "domain" && v.port && v.domainOnly));
  }

  async getPatternMatchedDomainsWithPort(category) {
    const patternsWithPort = (await this.getCategoryData(category)).filter(v => (v.type === "domain" && v.port && this.isDomainPattern(v.id)));
    const patternDomainsWithPort = await Promise.all(patternsWithPort.map(async p => {
      const domains = await this.getPatternDomains(p.id);
      return domains.map(d => Object.assign({}, p, {id: d}));
    }));
    return _.uniq(patternDomainsWithPort.flatMap(p => p));
  }

  async getAllDomainsWithPort(category) {
    return (await this.getCategoryData(category)).filter(v => (v.type === "domain" && v.port && !this.isDomainPattern(v.id)));
  }

  async getDefaultHashedDomains(category) {
    return rclient.smembersAsync(this.getDefaultCategoryKeyHashed(category))
  }

  async addCategoryData(category, domainObjs) {
    const domainObjStrs = domainObjs.map(obj => JSON.stringify(obj));
    await this.addSetMembers(this.getCategoryDataListKey(category), domainObjStrs);
  }

  async addDomainIntels(category, domains, intelExpire = 12 * 3600) {
    if (!['games', 'social', 'av', 'porn', 'gamble', 'p2p', 'vpn', 'default_c' ].includes(category)) return

    const intel = {
      category: category == 'default_c' ? 'intel' : category
    }
    await eachLimit(domains, 30, async domain => {
      await intelTool.addDomainIntel(domain.startsWith('*.') ? domain.substring(2) : domain, intel, intelExpire);
    })
  }

  async addDefaultDomains(category, domains, intelExpire) {
    await this.addSetMembers(this.getDefaultCategoryKey(category), domains);
    await this.addDomainIntels(category, domains, intelExpire)
  }

  async addDefaultDomainsOnly(category, domains, intelExpire) {
    await this.addSetMembers(this.getDefaultCategoryKeyOnly(category), domains);
    await this.addDomainIntels(category, domains, intelExpire)
  }

  async addDefaultHashedDomains(category, domains) {
    await this.addSetMembers(this.getDefaultCategoryKeyHashed(category), domains);
  }

  async getHitDomains(category) {
    return rclient.zrangeAsync(this.getHitCategoryKey(category), 0, -1);
  }

  async getCategoryData(category) {
    const data = await rclient.smembersAsync(this.getCategoryDataListKey(category));
    return data.map(d => JSON.parse(d));
  }

  async flushCategoryData(category) {
    return rclient.unlinkAsync(this.getCategoryDataListKey(category));
  }

  async flushCategoryAddresses(category) {
    return rclient.unlinkAsync(this.getDynamicAddressCategoryKey(category));
  }

  async flushDefaultDomains(category) {
    return rclient.unlinkAsync(this.getDefaultCategoryKey(category));
  }

  async flushDefaultDomainsOnly(category) {
    return rclient.unlinkAsync(this.getDefaultCategoryKeyOnly(category));
  }

  async flushDefaultHashedDomains(category) {
    return rclient.unlinkAsync(this.getDefaultCategoryKeyHashed(category));
  }

  async getIncludedDomainPatterns(category) {
    return rclient.smembersAsync(this.getIncludeCategoryKey(category)).then(results => results.filter(d => this.isDomainPattern(d)));
  }

  async getIncludedDomains(category) {
    return rclient.smembersAsync(this.getIncludeCategoryKey(category)).then(results => results.filter(d => !this.isDomainPattern(d)));
  }

  async addIncludedDomain(category, domain) {
    return rclient.saddAsync(this.getIncludeCategoryKey(category), domain)
  }

  async removeIncludedDomain(category, domain) {
    return rclient.sremAsync(this.getIncludeCategoryKey(category), domain)
  }

  async flushIncludedDomains(category) {
    return rclient.unlinkAsync(this.getIncludeCategoryKey(category));
  }

  async getIPv4Addresses(category) {
    if (await this.categoryDataListExists(category)) {
      return (await this.getCategoryData(category)).filter(v => (v.type === "ipv4" && !v.port)).map(v => v.id);
    }
    return super.getIPv4Addresses(category);
  }

  async getIPv6Addresses(category) {
    if (await this.categoryDataListExists(category)) {
      return (await this.getCategoryData(category)).filter(v => (v.type === "ipv6" && !v.port)).map(v => v.id);
    }
    return super.getIPv6Addresses(category);
  }

  async getIPv4AddressesWithPort(category) {
    return (await this.getCategoryData(category)).filter(v => (v.type === "ipv4" && v.port));
  }

  async getIPv6AddressesWithPort(category) {
    return (await this.getCategoryData(category)).filter(v => (v.type === "ipv6" && v.port));
  }

  async updateIncludedElements(category, elements) {
    if (!this.customizedCategories[category])
      throw new Error(`Category ${category} is not found`);
    if (!_.isArray(elements) || elements.length === 0)
      return;
    await this.flushIPv4Addresses(category);
    await this.flushIPv6Addresses(category);
    await this.flushIncludedDomains(category);

    const domainRegex = /^[-a-zA-Z0-9\.\*]+?/;
    let ipv4Addresses = [];
    let ipv6Addresses = [];
    switch (this.customizedCategories[category].type) {
      case "port":
        // use ipv4 and ipv6 data structure as a stub to store port numbers
        ipv4Addresses = elements;
        ipv6Addresses = elements;
        break;
      case "net":
      default:
        ipv4Addresses = elements.filter(e => new Address4(e).isValid());
        ipv6Addresses = elements.filter(e => new Address6(e).isValid());
    }

    const domains = elements.filter(e => !ipv4Addresses.includes(e) && !ipv6Addresses.includes(e) && domainRegex.test(e)).map(domain => domain.toLowerCase());
    if (ipv4Addresses.length > 0)
      await this.addIPv4Addresses(category, ipv4Addresses);
    if (ipv6Addresses.length > 0)
      await this.addIPv6Addresses(category, ipv6Addresses);
    if (domains.length > 0)
      await this.addIncludedDomain(category, domains);
  }

  async getIncludedElements(category) {
    if (!this.customizedCategories[category])
      throw new Error(`Category ${category} is not found`);
    const domains = await this.getIncludedDomains(category) || [];
    const ip4Addrs = await this.getIPv4Addresses(category) || [];
    const ip6Addrs = await this.getIPv6Addresses(category) || [];
    const elements = domains.concat(ip4Addrs).concat(ip6Addrs);
    return elements;
  }

  async getExcludedDomains(category) {
    return rclient.smembersAsync(this.getExcludeCategoryKey(category))
  }

  async addExcludedDomain(category, domain) {
    return rclient.saddAsync(this.getExcludeCategoryKey(category), domain)
  }

  async removeExcludedDomain(category, domain) {
    return rclient.sremAsync(this.getExcludeCategoryKey(category), domain)
  }

  async includeDomainExists(category, domain) {
    return rclient.sismemberAsync(this.getIncludeCategoryKey(category), domain)
  }

  async excludeDomainExists(category, domain) {
    return rclient.sismemberAsync(this.getExcludeCategoryKey(category), domain)
  }

  async defaultDomainExists(category, domain) {
    const result = await rclient.sismemberAsync(this.getDefaultCategoryKey(category), domain)
    return result == 1
  }

  async dynamicCategoryDomainExists(category, domain) {
    const score = await rclient.zscoreAsync(this.getCategoryKey(category), domain)
    return score !== null
  }

  async getDomainsWithExpireTime(category) {
    const key = this.getCategoryKey(category)

    const domainAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores')
    const results = []

    for (let i = 0; i < domainAndScores.length; i++) {
      if (i % 2 === 1) {
        const domain = domainAndScores[i - 1]
        const score = Number(domainAndScores[i])
        const expireDate = score + EXPIRE_TIME

        results.push({ domain: domain, expire: expireDate })
      }
    }

    return results
  }

  async updateDomainPattern(domain) {
    const matches = this.domainPatternTrie.find(domain);
    if (!_.isSet(matches))
      return;
    for (const match of matches) {
      const {pattern, category, isStatic, port} = match;
      if (!this.isActivated(category))
        return;
      
      const domainObj = {id: domain, isStatic};
      if (port)
        domainObj.port = port;
      const key = hashFunc(domainObj);
      if (!this.effectiveCategoryDomains[category])
        this.effectiveCategoryDomains[category] = new Map();
      if (!this.effectiveCategoryDomains[category].has(key)) {
        this.effectiveCategoryDomains[category].set(key, domainObj);
        const options = { exactMatch: true, blockSet: _.isEmpty(port) ? this.getIPSetName(category, isStatic) : this.getDomainPortIPSetName(category, isStatic) };
        if (this.isTLSActivated(category))
          options.tlsHostSet = Block.getTLSHostSet(category);
        if (!_.isEmpty(port))
          options.port = port;
        await domainBlock.blockDomain(domain, options);
        // add to redis set before calling updateCategoryBlock, pattern matched domains will be fetched from redis set in updateCategoryBlock
        await this.addPatternDomains(pattern, domain);
        await domainBlock.updateCategoryBlock(category);
      }
    }
  }

  isValidPort(port) {
    if (port && _.isNumber(port) && port > 0 && port < 65535)
      return true
    return false
  }

  getDynamicAddressCategoryKey(category) {
    return `dynamicCategoryAddress:${category}}`
  }

  isDynamicAddressCategoryExists(category) {
    return rclient.existsAsync(this.getDynamicAddressCategoryKey(category));
  }

  async getDynamicAddresses(category) {
    return  rclient.zrangeAsync(this.getDynamicAddressCategoryKey(category), 0, -1)
  }

  // entry format follow the same rule as domain's
  // example:
  // "{\"type\":\"IP\",\"id\":\"1.1.1.1\",\"port\":{\"proto\":\"udp\",\"start\":443,\"end\":443},\"pcount\":1,\"domainOnly\":true}"
  composeAddressEntry(address, proto, port) {
    if (!address || !proto || !port) {
      return
    }

    let entry = {}
    entry.type = "IP"
    entry.id = address

    let portObj = {}
    if (proto && port) {
      portObj.proto = proto
      portObj.start = port
      portObj.end = port
    }

    entry.port = portObj;
    entry.pcount = 1;
    entry.domainOnly = true;  // do not need to translate ip address

    entry.isStatic = true;

    return entry;
  }


  // might need support multi-port support or port range in the future?
  async addDynamicCategoryAddress(category, targetAddress, proto, targetPort, expireTime) {
    if (!category || !targetAddress || !proto) {
      return
    }
    let ipVersion = "";

    if (!net.isIPv4(targetAddress) && !net.isIPv6(targetAddress)){
      return
    }
    if (proto != "tcp" && proto != "udp") {  //bad proto
      return
    }
    if (!this.isValidPort(targetPort)) {
      return
    }
    const key = this.getDynamicAddressCategoryKey(category)


    let addrEntry  = this.composeAddressEntry(targetAddress, proto, targetPort);
    let data = JSON.stringify(addrEntry)


    // use current time as score for zset, it will be used to expire address
    const now = Math.floor(Date.now() / 1000)
    await rclient.zaddAsync(key, now, data)

    
    log.debug(`Add a ${category} targetAddress: ${targetAddress} targetPort: ${targetPort}`)

    // IP address not need to update dnsmasq config
    // skip ipset config update if category is not activated
    if (this.isActivated(category)) {
      if (!this.effectiveCategoryAdresses[category]) {
        this.effectiveCategoryAdresses[category] = new Map();
      }
      // await domainBlock.blockDomain(addrEntry.id, { ondemand: true, blockSet: this.getDomainPortIPSetName(category, addrEntry.isStatic), port: addrEntry.port, needComment: ipsetNeedComment });
      
      this.blockAddress(category, addrEntry.id, addrEntry.port, addrEntry.isStatic)
    }

  }

  async blockAddress(category, address, portObj, isStatic) {
    let blockSet = this.getDomainPortIPSetName(category, isStatic)
    await Block.batchBlockNetPort([address], portObj, blockSet).catch((err) => {
      log.error(`Failed to batch update domain ipset ${blockSet} for ${address}`, err.message);
    });
  }

  async unblockAddress(category, address, portObj, isStatic) {
    let blockSet = this.getDomainPortIPSetName(category, isStatic)
    await Block.batchUnblock([address], portObj, blockSet).catch((err) => {
      log.error(`Failed to batch update domain ipset ${blockSet} for ${address}`, err.message);
      });
  }

  async updateDomain(category, domain, isPattern, add = true) {

    if (!category || !domain) {
      return;
    }
    const key = this.getCategoryKey(category)

    let d = domain.toLowerCase()
    if (isPattern) {
      d = `*.${domain}`
    }

    // not dealing with delete here, it'll never be added
    const included = await this.includeDomainExists(category, d);
    if (!included) {
      const excluded = await this.excludeDomainExists(category, d);

      if (excluded) {
        return;
      }
    }

    log.debug(`${add ? 'Add' : 'Remove'} a ${category} domain: ${d}`)
    const dynamicCategoryDomainExists = await this.dynamicCategoryDomainExists(category, d)
    const defaultDomainExists = await this.defaultDomainExists(category, d);
    // whether d is covered by domain only list
    const isDomainOnly = (await this.getDefaultDomainsOnly(category))
      .some(dodd => dodd.startsWith("*.") ? d.endsWith(dodd.substring(1).toLowerCase()) : d === dodd.toLowerCase());

    if (add) {
      // use current time as score for zset, it will be used to expire domain
      const now = Math.floor(Date.now() / 1000)
      await rclient.zaddAsync(key, now, d)
    } else
      await rclient.zremAsync(key, d)

    // skip ipset and dnsmasq config update if category is not activated
    if (this.isActivated(category)) {
      if (!isDomainOnly) {
        if (!this.effectiveCategoryDomains[category]) {
          this.effectiveCategoryDomains[category] = new Map();
        }
        const domainObj = { id: d, isStatic: false };
        const key = hashFunc(domainObj);
        if (this.effectiveCategoryDomains[category].has(key) ^ add) { // XOR: true if only one is true
          if (add)
            this.effectiveCategoryDomains[category].set(key, domainObj);
          else
            this.effectiveCategoryDomains[category] = _.without(this.effectiveCategoryDomains[category], d)

          const action = add ? domainBlock.blockDomain.bind(domainBlock) : domainBlock.unblockDomain.bind(domainBlock)
          const options = { blockSet: this.getIPSetName(category) }
          if (this.isTLSActivated(category))
            options.tlsHostSet = Block.getTLSHostSet(category);

          if (d.startsWith("*."))
            await action(d.substring(2), options);
          else {
            options.exactMatch = true
            await action(d, options);
          }
        }
      }
      if (!dynamicCategoryDomainExists && !defaultDomainExists || !add) {
        domainBlock.updateCategoryBlock(category);
      }
    }
  }

  getDomainMapping(domain) {
    return `rdns:domain:${domain}`
  }
  getCategoryIpMapping(category) {
    return `rdns:category:${category}`
  }

  async getDomainMappingsByDomainPattern(domainPattern) {
    const keys = (await dnsTool.getSubDomains(domainPattern.substring(2))).map(d => this.getDomainMapping(d));
    keys.push(this.getDomainMapping(domainPattern.substring(2)))
    return keys
  }

  getSummedDomainMapping(domain) {
    let d = domain
    if (d.startsWith("*.")) {
      d = d.substring(2)
    }

    return `srdns:pattern:${d}`
  }

  // use "ipset restore" to add rdns entries to corresponding ipset
  async updateIPSetByDomain(category, domain, options) {
    if (!this.inited) return
    log.debug(`About to update category ${category} with domain ${domain}, options: ${JSON.stringify(options)}`)

    const mapping = this.getDomainMapping(domain)

    let ipsetName = this.getIPSetName(category, options.isStatic)
    let ipset6Name = this.getIPSetNameForIPV6(category, options.isStatic)

    if (options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category, options.isStatic)
      ipset6Name = this.getTempIPSetNameForIPV6(category, options.isStatic)
    }

    if (domain.startsWith("*.")) {
      return this.updateIPSetByDomainPattern(category, domain, options)
    }

    const categoryIps = await rclient.zrangeAsync(mapping, 0, -1).then(ips => ips.filter(ip => !firewalla.isReservedBlockingIP(ip)));
    if (categoryIps.length == 0) return;
    // Existing sets and elements are not erased by restore unless specified so in the restore file.
    // -! ignores error on entries already exists
    let cmd4 = `echo "${categoryIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = '`;
    if (options.needComment) {
      cmd4 += `| sed 's=$= comment ${domain}=' `;
    }
    cmd4 += `| sudo ipset restore -!`;
    let cmd6 = `echo "${categoryIps.join('\n')}" | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = '`;
    if (options.needComment) {
      cmd6 += `| sed 's=$= comment ${domain}=' `;
    }
    cmd6 += `| sudo ipset restore -!`;
    await exec(cmd4).catch((err) => {
      log.error(`Failed to update ipset by category ${category} domain ${domain}, err: ${err}`)
    })
    await exec(cmd6).catch((err) => {
      log.error(`Failed to update ipset6 by category ${category} domain ${domain}, err: ${err}`)
    })
  }

  async updateIPSetByDomainPort(category, domainObj, options) {
    if (!this.inited) return;
    log.debug(`About to update category ${category} with domain object ${domainObj}`);
    const domain = domainObj.id;
    const mapping = this.getDomainMapping(domain);

    let ipsetName = this.getDomainPortIPSetName(category, options.isStatic);
    let ipset6Name = this.getDomainPortIPSetNameForIPV6(category, options.isStatic);

    if (options && options.useTemp) {
      ipsetName = this.getTempDomainPortIPSetName(category, options.isStatic);
      ipset6Name = this.getTempDomainPortIPSetNameForIPV6(category, options.isStatic);
    }

    if (domain.startsWith("*.")) {
      return this.updateIPSetByDomainPatternPort(category, domainObj, options);
    }

    const categoryIps = await rclient.zrangeAsync(mapping, 0, -1).then(ips => ips.filter(ip => !firewalla.isReservedBlockingIP(ip)));
    if (categoryIps.length == 0) return;
    // Existing sets and elements are not erased by restore unless specified so in the restore file.
    // -! ignores error on entries already exists
    const portObj = domainObj.port;
    let cmd4 = `echo "${categoryIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sed 's=$=,${CategoryEntry.toPortStr(portObj)}=' `;
    if (options.needComment) {
      cmd4 += `| sed 's=$= comment ${domain}=' `;
    }
    cmd4 += `| sudo ipset restore -!`;
    let cmd6 = `echo "${categoryIps.join('\n')}" | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sed 's=$=,${CategoryEntry.toPortStr(portObj)}=' `;
    if (options.needComment) {
      cmd6 += `| sed 's=$= comment ${domain}=' `;
    }
    cmd6 += `| sudo ipset restore -!`;
    await exec(cmd4).catch((err) => {
      log.error(`Failed to update ipset by category ${category} domain ${domain}, err: ${err}`)
    })
    await exec(cmd6).catch((err) => {
      log.error(`Failed to update ipset6 by category ${category} domain ${domain}, err: ${err}`)
    })

  }

  async filterIPSetByDomain(category, options) {
    if (!this.inited) return

    options = options || {}

    const list = this.excludedDomains && this.excludedDomains[category];

    if (!_.isEmpty(list)) {
      for (const domain of list) {
        if (domain.startsWith("*.")) {
          await this._filterIPSetByDomainPattern(category, domain, options).catch((err) => {
            log.error("Got error when filter ip set for domain pattern", domain, "with err", err);
          });
        } else {
          await this._filterIPSetByDomain(category, domain, options).catch((err) => {
            log.error("Got error when filter ip set for domain", domain, "with err", err);
          })
        }
      }
    }
  }

  async _filterIPSetByDomain(category, domain, options) {
    options = options || {}

    const mapping = this.getDomainMapping(domain)
    let ipsetName = this.getIPSetName(category, options.isStatic)
    let ipset6Name = this.getIPSetNameForIPV6(category, options.isStatic)

    if (options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category, options.isStatic)
      ipset6Name = this.getTempIPSetNameForIPV6(category, options.isStatic)
    }

    const categoryFilterIps = await rclient.zrangeAsync(mapping, 0, -1);
    if (categoryFilterIps.length == 0) return;
    let cmd4 = `echo "${categoryFilterIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=del ${ipsetName} = ' | sudo ipset restore -!`
    let cmd6 = `echo "${categoryFilterIps.join('\n')}" | egrep ".*:.*" | sed 's=^=del ${ipset6Name} = ' | sudo ipset restore -!`
    await exec(cmd4).catch((err) => {
      log.error(`Failed to delete ipset by category ${category} domain ${domain}, err: ${err}`)
    })
    await exec(cmd6).catch((err) => {
      log.error(`Failed to delete ipset6 by category ${category} domain ${domain}, err: ${err}`)
    })
    const categoryIpMappingKey = this.getCategoryIpMapping(category);
    await rclient.sremAsync(categoryIpMappingKey, categoryFilterIps);

  }

  async _filterIPSetByDomainPattern(category, domain, options) {
    if (!domain.startsWith("*.")) {
      return
    }

    const mappings = await this.getDomainMappingsByDomainPattern(domain)

    if (mappings.length > 0) {
      const smappings = this.getSummedDomainMapping(domain)
      let array = [smappings, mappings.length]

      array.push.apply(array, mappings, "AGGREGATE", "MAX");

      await rclient.zunionstoreAsync(array)

      const exists = await rclient.typeAsync(smappings);
      if (exists === "none") {
        return; // if smapping doesn't exist, meaning no ip found for this domain, sometimes true for pre-provided domain list
      }

      await rclient.expireAsync(smappings, 600) // auto expire in 10 minutes

      let ipsetName = this.getIPSetName(category, options.isStatic)
      let ipset6Name = this.getIPSetNameForIPV6(category, options.isStatic)

      if (options && options.useTemp) {
        ipsetName = this.getTempIPSetName(category, options.isStatic)
        ipset6Name = this.getTempIPSetNameForIPV6(category, options.isStatic)
      }
      const categoryFilterIps = await rclient.zrangeAsync(smappings, 0, -1);
      if (categoryFilterIps.length == 0) return;
      let cmd4 = `echo "${categoryFilterIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=del ${ipsetName} = ' | sudo ipset restore -!`
      let cmd6 = `echo "${categoryFilterIps.join('\n')}" | egrep ".*:.*" | sed 's=^=del ${ipset6Name} = ' | sudo ipset restore -!`
      try {
        await exec(cmd4);
        await exec(cmd6);
      } catch (err) {
        log.error(`Failed to filter ipset by category ${category} domain pattern ${domain}, err: ${err}`)
      }
      const categoryIpMappingKey = this.getCategoryIpMapping(category);
      await rclient.sremAsync(categoryIpMappingKey, categoryFilterIps);
    }
  }

  async updateIPSetByDomainPattern(category, domain, options) {
    if (!domain.startsWith("*.")) {
      return
    }

    log.debug(`About to update category ${category} with domain pattern ${domain}, options: ${JSON.stringify(options)}`)

    const mappings = await this.getDomainMappingsByDomainPattern(domain)

    if (mappings.length > 0) {
      const smappings = this.getSummedDomainMapping(domain)
      let array = [smappings, mappings.length]

      array.push.apply(array, mappings)

      await rclient.zunionstoreAsync(array)

      const exists = await rclient.typeAsync(smappings);
      if (exists === "none") {
        return; // if smapping doesn't exist, meaning no ip found for this domain, sometimes true for pre-provided domain list
      }

      await rclient.expireAsync(smappings, 600) // auto expire in 10 minutes

      let ipsetName = this.getIPSetName(category, options.isStatic)
      let ipset6Name = this.getIPSetNameForIPV6(category, options.isStatic)

      if (options && options.useTemp) {
        ipsetName = this.getTempIPSetName(category, options.isStatic)
        ipset6Name = this.getTempIPSetNameForIPV6(category, options.isStatic)
      }
      const categoryIps = await rclient.zrangeAsync(smappings, 0, -1).then(ips => ips.filter(ip => !firewalla.isReservedBlockingIP(ip)));
      if (categoryIps.length == 0) return;
      let cmd4 = `echo "${categoryIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = '`
      if (options.needComment) {
        cmd4 += `| sed 's=$= comment ${domain}=' `;
      }
      cmd4 += `| sudo ipset restore -!`;
      let cmd6 = `echo "${categoryIps.join('\n')}" | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' `;
      if (options.needComment) {
        cmd6 += `| sed 's=$= comment ${domain}=' `;
      }
      cmd6 += `| sudo ipset restore -!`;
      try {
        await exec(cmd4)
        await exec(cmd6)
      } catch (err) {
        log.error(`Failed to update ipset by category ${category} domain pattern ${domain}, err: ${err}`)
      }
    }
  }

  async updateIPSetByDomainPatternPort(category, domainObj, options) {
    const domain = domainObj.id;
    if (!domain.startsWith("*.")) {
      return
    }

    log.debug(`About to update category ${category} with domain pattern port ${domainObj}, options: ${JSON.stringify(options)}`)

    const mappings = await this.getDomainMappingsByDomainPattern(domain)

    if (mappings.length > 0) {
      const smappings = this.getSummedDomainMapping(domain)
      let array = [smappings, mappings.length]

      array.push.apply(array, mappings)

      await rclient.zunionstoreAsync(array)

      const exists = await rclient.typeAsync(smappings);
      if (exists === "none") {
        return; // if smapping doesn't exist, meaning no ip found for this domain, sometimes true for pre-provided domain list
      }

      await rclient.expireAsync(smappings, 600) // auto expire in 10 minutes

      let ipsetName = this.getDomainPortIPSetName(category, options.isStatic);
      let ipset6Name = this.getDomainPortIPSetNameForIPV6(category, options.isStatic);

      if (options && options.useTemp) {
        ipsetName = this.getTempDomainPortIPSetName(category, options.isStatic);
        ipset6Name = this.getTempDomainPortIPSetNameForIPV6(category, options.isStatic);
      }
      const categoryIps = await rclient.zrangeAsync(smappings, 0, -1).then(ips => ips.filter(ip => !firewalla.isReservedBlockingIP(ip)));
      if (categoryIps.length == 0) return;

      const portObj = domainObj.port;
      let cmd4 = `echo "${categoryIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sed 's=$=,${CategoryEntry.toPortStr(portObj)}=' `;
      if (options.needComment) {
        cmd4 += `| sed 's=$= comment ${domain}=' `;
      }
      cmd4 += `| sudo ipset restore -!`;
      let cmd6 = `echo "${categoryIps.join('\n')}" | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sed 's=$=,${CategoryEntry.toPortStr(portObj)}=' `;
      if (options.needComment) {
        cmd6 += `| sed 's=$= comment ${domain}=' `;
      }
      cmd6 += `| sudo ipset restore -!`;
      try {
        await exec(cmd4)
        await exec(cmd6)
      } catch (err) {
        log.error(`Failed to update ipset by category ${category} domain pattern ${domain}, err: ${err}`)
      }

    }
  }

  isDomainContainWildcardInMiddle(domain) {
    if ((!domain.startsWith("*.") && domain.includes("*")) 
      || (domain.startsWith("*.") && domain.substring(2).includes("*")))
      return true;
    return false;
  }

  // rebuild category ipset
  async recycleIPSet(category) {
    if (this.recycleTasks[category]) {
      log.info(`Recycle ipset task for ${category} is already running`);
      return;
    }
    this.recycleTasks[category] = true;

    let ondemand = this.isCustomizedCategory(category);

    const ipsetNeedComment = this.needIpSetComment(category);
    const updateOptions = {};
    if (ipsetNeedComment) {
      updateOptions.comment = "persistent";
    }

    await this.updatePersistentIPSets(category, false, updateOptions);
    await this.updatePersistentIPSets(category, true, updateOptions);

    const strategy = await this.getStrategy(category);
    const domains = await this.getDomains(category);
    const includedDomains = await this.getIncludedDomains(category);
    let defaultDomains;
    if (strategy.ipset.useHitSet) {
      defaultDomains = await this.getHitDomains(category);
    } else {
      defaultDomains = await this.getDefaultDomains(category);
    }

    const patternMatchedDomains = await this.getPatternMatchedDomains(category);

    const excludeDomains = await this.getExcludedDomains(category);
    const domainOnlyDefaultDomains = await this.getDefaultDomainsOnly(category);

    let domainMap = new Map();

    // dynamic + default + pattern match - exclude + include - defaultDomainOnly
    let dd = _.union(domains, defaultDomains, patternMatchedDomains)
    dd = _.difference(dd, excludeDomains)
    dd = _.union(dd, includedDomains)
    dd = dd.map(d => d.toLowerCase());
    dd = dd.filter(d => !domainOnlyDefaultDomains.some(dodd => dodd.startsWith("*.") ? d.endsWith(dodd.substring(1).toLowerCase()) : d === dodd.toLowerCase()));
    // do not add domain only default domains to the ipset
    // const dd = domainBlock.getCategoryDomains(category, strategy.ipset.useHitSet, false, false)

    for (const d of dd) {
      if (this.isDomainContainWildcardInMiddle(d)) // skip domain pattern
        continue;
      const domainObj = { id: d, isStatic: false };
      domainMap.set(hashFunc(domainObj), domainObj);
    }

    for (const item of await this.getDefaultDomainsOnlyWithPort(category)) {
      if (this.isDomainContainWildcardInMiddle(item.id)) // skip domain pattern
        continue;
      const domainObj = { id: item.id, port: item.port, isStatic: false };
      domainMap.set(hashFunc(domainObj), domainObj);
    }

    for (const item of await this.getDefaultDomainsWithPort(category)) {
      if (this.isDomainContainWildcardInMiddle(item.id)) // skip domain pattern
        continue;
      const domainObj = { id: item.id, port: item.port, isStatic: true };
      domainMap.set(hashFunc(domainObj), domainObj);
    }

    for (const item of await this.getPatternMatchedDomainsWithPort(category)) {
      if (this.isDomainContainWildcardInMiddle(item.id)) // skip domain pattern
        continue;
      const domainObj = { id: item.id, port: item.port, isStatic: true };
      domainMap.set(hashFunc(domainObj), domainObj);
    }

    if ((domainMap && domainMap.size > 1000) || strategy.ipset.useHitSet) {
      ondemand = true;
      log.info(`Category ${category} has ${domainMap.size} domains, recycle IPset will run in on-demand mode`);
    }

    const previousEffectiveDomains = this.effectiveCategoryDomains[category] || new Map();

    const removedDomains = [];
    for (const [k, v] of previousEffectiveDomains) {
      if (!domainMap.has(k)) {
        removedDomains.push(v)
      }
    }
    for (const domainObj of removedDomains) {
      const domain = domainObj.id;
      log.debug(`Domain ${domain} is removed from category ${category}, unregister domain updater ...`, domainObj);
      let domainSuffix = domain
      if (domainSuffix.startsWith("*.")) {
        domainSuffix = domainSuffix.substring(2);
      }
      // unregister domain updater for removed domain
      // will skip unapply in unblockDomain because the ipset will be flushed later if ondemand is false.
      if (domain.startsWith("*.")) {
        if (domainObj.port) {
          await domainBlock.unblockDomain(domain.substring(2), { blockSet: this.getDomainPortIPSetName(category, domainObj.isStatic), port: domainObj.port, skipUnapply: !ondemand });
        } else {
          await domainBlock.unblockDomain(domainSuffix, { blockSet: this.getIPSetName(category, domainObj.isStatic), skipUnapply: !ondemand });
        }
      } else {
        if (domainObj.port) {
          await domainBlock.unblockDomain(domain, { exactMatch: true, blockSet: this.getDomainPortIPSetName(category, domainObj.isStatic), port: domainObj.port, skipUnapply: !ondemand });
        } else {
          await domainBlock.unblockDomain(domainSuffix, { exactMatch: true, blockSet: this.getIPSetName(category, domainObj.isStatic), skipUnapply: !ondemand });
        }
      }
    }

    const previousEffectiveAddresses = this.effectiveCategoryAdresses[category] || new Map()


    let addressMap = new Map()

    for (const item of await this.getDynamicAddresses(category)) {
      const addressObj = { id: item.id, port: item.port, isStatic: true }
      addressMap.set(hashFunc(addressObj), addressObj);
    }

    let removedAddresses = []
    for (const [k, v] of previousEffectiveAddresses) {
      if (!addressMap.has(k)) {
        removedAddresses.push(v)
      }
    }
    for (const addressObj of removedAddresses) {
      log.debug(`Address ${addressObj.id} is removed from category ${category}, remove address from ipset ...`)
      await this.unblockAddress(category, addressObj.id, addressObj.port, addressObj.isStatic);
    }


    // do not execute full update on ipset if ondemand is set
    if (!ondemand) {
      for (const [k, v] of domainMap) {
        const domain = v.id;
        let domainSuffix = domain
        if (domainSuffix.startsWith("*.")) {
          domainSuffix = domainSuffix.substring(2);
        }

        const existing = await dnsTool.reverseDNSKeyExists(domainSuffix)
        if (!existing) { // a new domain
          log.verbose(`Found a new domain for ${category} with rdns: ${domainSuffix}`)
          await domainBlock.resolveDomain(domainSuffix)
        }
        // regenerate ipmapping set in redis
        await domainBlock.syncDomainIPMapping(domainSuffix,
          {
            blockSet: v.port ? this.getDomainPortIPSetName(category, v.isStatic) : this.getIPSetName(category, v.isStatic),
            exactMatch: (domain.startsWith("*.") ? false : true),
            overwrite: true,
            ondemand: true, // do not try to resolve domain in syncDomainIPMapping
            port: v.port || null
          }
        );
        if (!v.port) {
          await this.updateIPSetByDomain(category, domain, { useTemp: true, isStatic: v.isStatic, needComment: ipsetNeedComment });
        } else {
          await this.updateIPSetByDomainPort(category, v, { useTemp: true, isStatic: v.isStatic, needComment: ipsetNeedComment });
        }
      }
      await this.filterIPSetByDomain(category, { useTemp: true });
      await this.filterIPSetByDomain(category, { useTemp: true, isStatic: true });
      await this.swapIpset(category);
    }

    log.info(`Successfully recycled ipset for category ${category}`)

    const newDomains = [];
    for (const [k, v] of domainMap) {
      if (!previousEffectiveDomains.has(k)) {
        newDomains.push(v);
      }
    }
    for (const domainObj of newDomains) {
      // register domain updater for new effective domain
      // ondemand is set to "true" because we don't want blockDomain to update ipset directly because it has been handled above.
      const domain = domainObj.id;
      if (domain.startsWith("*.")) {
        if (domainObj.port) {
          await domainBlock.blockDomain(domain.substring(2), { ondemand: true, blockSet: this.getDomainPortIPSetName(category, domainObj.isStatic), port: domainObj.port, needComment: ipsetNeedComment });
        } else {
          await domainBlock.blockDomain(domain.substring(2), { ondemand: true, blockSet: this.getIPSetName(category, domainObj.isStatic), needComment: ipsetNeedComment });
        }
      } else {
        if (domainObj.port) {
          await domainBlock.blockDomain(domain, { ondemand: true, exactMatch: true, blockSet: this.getDomainPortIPSetName(category, domainObj.isStatic), port: domainObj.port, needComment: ipsetNeedComment });
        } else {
          await domainBlock.blockDomain(domain, { ondemand: true, exactMatch: true, blockSet: this.getIPSetName(category, domainObj.isStatic), needComment: ipsetNeedComment });
        }
      }
    }
    this.effectiveCategoryDomains[category] = domainMap;

    const newAddresses = [];
    for (const [k, v] of addressMap) {
      if (!previousEffectiveAddresses.has(k)) {
        newAddresses.push(v);
      }
    }
    for (const addressObj of newAddresses) {
      await this.blockAddress(category, addressObj.id, addressObj.port, addressObj.isStatic)
    }

    this.effectiveCategoryAdresses[category] = addressMap;

    this.recycleTasks[category] = false;
  }

  async refreshCategoryRecord(category) {
    const domainsKey = this.getCategoryKey(category)
    const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

    await rclient.zremrangebyscoreAsync(domainsKey, '-inf', date)

    const addresseskey = this.getDynamicAddressCategoryKey(category)
    await rclient.zremrangebyscoreAsync(addresseskey, '-inf', date)
  }

  getEffectiveDomains(category) {
    return this.effectiveCategoryDomains[category];
  }

  async addSetMembers(key, items) {
    let commands = [key];
    let batchCount = 0;
    for (const item of items) {
      commands.push(item);
      batchCount++;
      if (batchCount === 10000) {
        await rclient.saddAsync(commands);
        commands = [key];
        batchCount = 0;
      }
    }
    if (batchCount !== 0) {
      await rclient.saddAsync(commands);
      commands = [key];
    }
    return;
  }

  decideStrategy(category, categoryMeta) {
    if (!fc.isFeatureOn("category_filter")) {
      return "normal";
    }
    if (this.isManagedTargetList(category) && categoryMeta.domainCount >= 1000) {
      return "filter";
    }
    return "normal";
  }

  async getStrategy(category) {
    const defaultStrategyConfig = {
      needOptimization: false,

      updateConfirmSet: false,
      checkCloud: false,

      useHitSetDefault: false,
      tls: {
        enabled: true,
        useHitSet: false,
      },
      dnsmasq: {
        enabled: true,
        useFilter: false
      },
      ipset: {
        enabled: true,
        useHitSet: false
      },
      exception: {
        useHitSet: false
      }
    };

    const categoryStrategy = await rclient.getAsync(this.getCategoryStrategyKey(category));
    if (!categoryStrategy) {
      return defaultStrategyConfig;
    }
    switch (categoryStrategy) {
      case "filter":
        return {
          needOptimization: true,

          updateConfirmSet: true,
          checkCloud: true,

          useHitSetDefault: true,
          tls: {
            enabled: true,
            useHitSet: true
          },
          dnsmasq: {
            enabled: true,
            useFilter: true
          },
          ipset: {
            enabled: true,
            useHitSet: true
          },
          exception: {
            useHitSet: true
          }
        };
      case "adblock":
      // only enable dnsmasq for adblock strict mode.
      return {
        needOptimization: true,

        updateConfirmSet: true,
        checkCloud: true,

        useHitSetDefault: true,
        tls: {
          enabled: false,
          useHitSet: true
        },
        dnsmasq: {
          enabled: true,
          useFilter: true
        },
        ipset: {
          enabled: false,
          useHitSet: true
        },
        exception: {
          useHitSet: true
        }
      };
      default:
      return defaultStrategyConfig;
    }
  }

  getCategoryFilterDir() {
    return CATEGORY_FILTER_DIR;
  }

  async updateStrategy(category, strategy) {
    await rclient.setAsync(this.getCategoryStrategyKey(category), strategy);
    return;
  }

  // system target list using cloudcache, mainly for large target list to reduce bandwidth usage of polling hashset
  isManagedTargetList(category) {
    return !this.isUserTargetList(category) && !this.isSmallExtendedTargetList(category) && !this.excludeListBundleIds.has(category) && !category.endsWith('_bf');
  }
}

module.exports = CategoryUpdater;
