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

const rclient = require('../util/redis_manager.js').getRedisClient()

const firewalla = require("../net2/Firewalla.js");

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const CategoryUpdaterBase = require('./CategoryUpdaterBase.js');
const domainBlock = require('../control/DomainBlock.js');
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

class CategoryUpdater extends CategoryUpdaterBase {

  constructor() {
    if (instance == null) {
      super()
      this.inited = false;
      instance = this

      this.effectiveCategoryDomains = {};

      this.activeCategories = {
        "default_c": 1
        // categories below should be activated on demand
        /*
        "games": 1,
        "social": 1,
        "porn": 1,
        "shopping": 1,
        "av": 1,
        "p2p": 1,
        "gamble": 1,
        "vpn": 1
        */
      };

      this.activeTLSCategories = {}; // default_c is not preset here because hostset file is generated only if iptables rule is created.

      this.customizedCategories = {};

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

      this.excludeListBundleIds = new Set(["default_c", "adblock_strict", "games", "social", "av", "porn", "gamble", "p2p", "vpn"]);

      this.refreshCustomizedCategories();

      sem.on("CustomizedCategory:Updated", async () => {
        if (firewalla.isMain()) {
          await this.refreshCustomizedCategories();
        }
      });

      if (firewalla.isMain()) {
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
                  if (strategy.ipset.enabled) {
                    await this.recycleIPSet(event.category);
                  }
                } catch (err) {
                  log.error(`Failed to update category domain ${event.category}`, err.message);
                }
              }
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

  async refreshTLSCategoryActivated() {
    try {
      const cmdResult = await exec(`ls -l /proc/net/xt_tls/hostset |awk '{print $9}'`);
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
    let c = null;
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
          category: c
        };
        sem.sendEventToAll(event);
        sem.emitLocalEvent(event);
      }
      delete this.customizedCategories[c];
    }
    return this.customizedCategories;
  }

  async activateCategory(category) {
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

  async getDomains(category) {
    return rclient.zrangeAsync(this.getCategoryKey(category), 0, -1)
  }

  async getDefaultDomains(category) {
    return rclient.smembersAsync(this.getDefaultCategoryKey(category))
  }

  async getDefaultDomainsOnly(category) {
    return rclient.smembersAsync(this.getDefaultCategoryKeyOnly(category))
  }

  async getDefaultHashedDomains(category) {
    return rclient.smembersAsync(this.getDefaultCategoryKeyHashed(category))
  }

  async addDefaultDomains(category, domains) {
    await this.addSetMembers(this.getDefaultCategoryKey(category), domains);
  }

  async addDefaultDomainsOnly(category, domains) {
    await this.addSetMembers(this.getDefaultCategoryKeyOnly(category), domains);
  }

  async addDefaultHashedDomains(category, domains) {
    await this.addSetMembers(this.getDefaultCategoryKeyHashed(category), domains);
  }

  async getHitDomains(category) {
    return rclient.zrangeAsync(this.getHitCategoryKey(category), 0, -1);
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

  async getIncludedDomains(category) {
    return rclient.smembersAsync(this.getIncludeCategoryKey(category))
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
    const defaultDomains = await this.getDefaultDomains(category) || [];
    return defaultDomains.indexOf(domain) > -1
  }
  async dynamicCategoryDomainExists(category, domain) {
    const dynamicCategoryDomains = await this.getDomains(category) || [];
    return dynamicCategoryDomains.indexOf(domain) > -1
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

  async updateDomain(category, domain, isPattern) {

    if (!category || !domain) {
      return;
    }
    const now = Math.floor(new Date() / 1000)
    const key = this.getCategoryKey(category)

    let d = domain.toLowerCase()
    if (isPattern) {
      d = `*.${domain}`
    }

    const included = await this.includeDomainExists(category, d);

    if (!included) {
      const excluded = await this.excludeDomainExists(category, d);

      if (excluded) {
        return;
      }
    }

    log.debug(`Found a ${category} domain: ${d}`)
    const dynamicCategoryDomainExists = await this.dynamicCategoryDomainExists(category, d)
    const defaultDomainExists = await this.defaultDomainExists(category, d);
    const isDomainOnly = (await this.getDefaultDomainsOnly(category)).some(dodd => dodd.startsWith("*.") ? d.endsWith(dodd.substring(1).toLowerCase()) : d === dodd.toLowerCase());
    await rclient.zaddAsync(key, now, d) // use current time as score for zset, it will be used to know when it should be expired out

    // skip ipset and dnsmasq config update if category is not activated
    if (this.isActivated(category)) {
      if (!isDomainOnly) {
        if (!this.effectiveCategoryDomains[category])
          this.effectiveCategoryDomains[category] = [];
        if (!this.effectiveCategoryDomains[category].includes(d)) {
          this.effectiveCategoryDomains[category].push(d);
          if (d.startsWith("*."))
            await domainBlock.blockDomain(d.substring(2), {blockSet: this.getIPSetName(category)});
          else
            await domainBlock.blockDomain(d, {exactMatch: true, blockSet: this.getIPSetName(category)});
        }
      }
      if (!dynamicCategoryDomainExists && !defaultDomainExists) {
        domainBlock.updateCategoryBlock(category);
      }
    }
    if (this.isTLSActivated(category)) {
      domainBlock.appendDomainToCategoryTLSHostSet(category, d);
    }
  }

  getDomainMapping(domain) {
    return `rdns:domain:${domain}`
  }
  getCategoryIpMapping(category) {
    return `rdns:category:${category}`
  }

  async getDomainMappingsByDomainPattern(domainPattern) {
    const keys = await rclient.scanResults(this.getDomainMapping(domainPattern))
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
    let ipsetName = this.getIPSetName(category)
    let ipset6Name = this.getIPSetNameForIPV6(category)

    if (options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category)
      ipset6Name = this.getTempIPSetNameForIPV6(category)
    }

    if (domain.startsWith("*.")) {
      return this.updateIPSetByDomainPattern(category, domain, options)
    }

    const categoryIps = await rclient.zrangeAsync(mapping, 0, -1).then(ips => ips.filter(ip => !firewalla.isReservedBlockingIP(ip)));
    if (categoryIps.length == 0) return;
    // Existing sets and elements are not erased by restore unless specified so in the restore file.
    // -! ignores error on entries already exists
    let cmd4 = `echo "${categoryIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
    let cmd6 = `echo "${categoryIps.join('\n')}" | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
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
    let ipsetName = this.getIPSetName(category)
    let ipset6Name = this.getIPSetNameForIPV6(category)

    if (options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category)
      ipset6Name = this.getTempIPSetNameForIPV6(category)
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

      let ipsetName = this.getIPSetName(category)
      let ipset6Name = this.getIPSetNameForIPV6(category)

      if (options && options.useTemp) {
        ipsetName = this.getTempIPSetName(category)
        ipset6Name = this.getTempIPSetNameForIPV6(category)
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

      let ipsetName = this.getIPSetName(category)
      let ipset6Name = this.getIPSetNameForIPV6(category)

      if (options && options.useTemp) {
        ipsetName = this.getTempIPSetName(category)
        ipset6Name = this.getTempIPSetNameForIPV6(category)
      }
      const categoryIps = await rclient.zrangeAsync(smappings, 0, -1).then(ips => ips.filter(ip => !firewalla.isReservedBlockingIP(ip)));
      if (categoryIps.length == 0) return;
      let cmd4 = `echo "${categoryIps.join('\n')}" | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      let cmd6 = `echo "${categoryIps.join('\n')}" | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
      try {
        await exec(cmd4)
        await exec(cmd6)
      } catch (err) {
        log.error(`Failed to update ipset by category ${category} domain pattern ${domain}, err: ${err}`)
      }
    }
  }

  // rebuild category ipset
  async recycleIPSet(category) {
    if (this.recycleTasks[category]) {
      log.info(`Recycle ipset task for ${category} is already running`);
      return;
    }
    this.recycleTasks[category] = true;

    let ondemand = this.isCustomizedCategory(category);

    await this.updatePersistentIPSets(category, { useTemp: true });

    const strategy = await this.getStrategy(category);
    const domains = await this.getDomains(category);
    const includedDomains = await this.getIncludedDomains(category);
    let defaultDomains;
    if (strategy.ipset.useHitSet) {
      defaultDomains = await this.getHitDomains(category);
    } else {
      defaultDomains = await this.getDefaultDomains(category);
    }
    const excludeDomains = await this.getExcludedDomains(category);
    const domainOnlyDefaultDomains = await this.getDefaultDomainsOnly(category);

    let dd = _.union(domains, defaultDomains)
    dd = _.difference(dd, excludeDomains)
    dd = _.union(dd, includedDomains)
    dd = dd.map(d => d.toLowerCase());
    // do not add domain only default domains to the ipset
    dd = dd.filter(d => !domainOnlyDefaultDomains.some(dodd => dodd.startsWith("*.") ? d.endsWith(dodd.substring(1).toLowerCase()) : d === dodd.toLowerCase()));

    if ((dd && dd.length > 1000) || strategy.ipset.useHitSet) {
      ondemand = true;
      log.info(`Category ${category} has ${dd.length} domains, recycle IPset will run in on-demand mode`);
    }

    const previousEffectiveDomains = this.effectiveCategoryDomains[category] || [];
    const removedDomains = _.difference(previousEffectiveDomains, dd);
    for (const domain of removedDomains) {
      log.debug(`Domain ${domain} is removed from category ${category}, unregister domain updater ...`);
      let domainSuffix = domain
      if (domainSuffix.startsWith("*.")) {
        domainSuffix = domainSuffix.substring(2);
      }
      if (domain.startsWith("*."))
        await domainBlock.unblockDomain(domainSuffix, { blockSet: this.getIPSetName(category) });
      else
        await domainBlock.unblockDomain(domainSuffix, { exactMatch: true, blockSet: this.getIPSetName(category) });
    }

    for (const domain of dd) {

      let domainSuffix = domain
      if (domainSuffix.startsWith("*.")) {
        domainSuffix = domainSuffix.substring(2);
      }

      // do not execute full update on ipset if ondemand is set
      if (!ondemand) {
        const existing = await dnsTool.reverseDNSKeyExists(domainSuffix)
        if (!existing) { // a new domain
          log.info(`Found a new domain with new rdns: ${domainSuffix}`)
          await domainBlock.resolveDomain(domainSuffix)
        }
        // regenerate ipmapping set in redis
        await domainBlock.syncDomainIPMapping(domainSuffix,
          {
            blockSet: this.getIPSetName(category),
            exactMatch: (domain.startsWith("*.") ? false : true),
            overwrite: true,
            ondemand: true // do not try to resolve domain in syncDomainIPMapping
          }
        );
        await this.updateIPSetByDomain(category, domain, { useTemp: true });
      }
    }
    if (!ondemand) {
      await this.filterIPSetByDomain(category, { useTemp: true });
      await this.swapIpset(category);
    }

    log.info(`Successfully recycled ipset for category ${category}`)

    const newDomains = _.difference(dd, previousEffectiveDomains);
    for (const domain of newDomains) {
      // register domain updater for new effective domain
      // log.info(`Domain ${domain} is added to category ${category}, register domain updater ...`)
      if (domain.startsWith("*."))
        await domainBlock.blockDomain(domain.substring(2), { ondemand: ondemand, blockSet: this.getIPSetName(category) });
      else
        await domainBlock.blockDomain(domain, { ondemand: ondemand, exactMatch: true, blockSet: this.getIPSetName(category) });
    }
    this.effectiveCategoryDomains[category] = dd;

    this.recycleTasks[category] = false;
  }

  async refreshCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

    return rclient.zremrangebyscoreAsync(key, '-inf', date)
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

  isManagedTargetList(category) {
    return !category.startsWith("TL-") && !this.excludeListBundleIds.has(category);
  }
}

module.exports = CategoryUpdater;
