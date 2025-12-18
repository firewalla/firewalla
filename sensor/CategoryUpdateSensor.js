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

const log = require('../net2/logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const fc = require('../net2/config.js')

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js');

const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();
const CountryUpdater = require('../control/CountryUpdater.js');
const countryUpdater = new CountryUpdater();

const { Address4, Address6 } = require('ip-address');

const { isHashDomain } = require('../util/util.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const util = require('util');

const fs = require('fs');
const exec = require('child-process-promise').exec;
const { execSync } = require('child_process');
const cloudcache = require('../extension/cloudcache/cloudcache');
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);

const _ = require('lodash');
const { CategoryEntry } = require('../control/CategoryEntry.js');

const INTEL_PROXY_CHANNEL = "intel_proxy";

const MAX_DOMAIN_PORT_COUNT = 1000;
const MAX_IP_PORT_COUNT = 20000;

const securityHashMapping = {
  "default_c": "blockset:default:consumer"
}

const CATEGORY_DATA_KEY = "intel_proxy.data";
const Constants = require('../net2/Constants.js');
class CategoryUpdateSensor extends Sensor {
  constructor(config) {
    super(config)

    this.resetCategoryHashsetMapping()
  }

  async regularJob() {
    try {
      const categories = Object.keys(this.categoryHashsetMapping)
      log.info('Native categories', categories);
      for (const category of categories) {
        await this.updateCategory(category);
      }
      await this.updateFlowSignatureList(true);
    } catch (err) {
      log.error("Failed to update categories", err)
    }
  }

  resetCategoryHashsetMapping() {
    this.categoryHashsetMapping = CategoryUpdater.getCategoryHashsetMapping();
  }

  async securityJob() {
    try {
      const securityCategories = Object.keys(securityHashMapping)
      log.info('Active security categories', securityCategories);
      for (const category of securityCategories) {
        await this.updateSecurityCategory(category)
      }
    } catch (err) {
      log.error("Failed to update security categories", err)
    }
  }

  async countryJob() {
    try {
      await this.renewCountryList();
      const activeCountries = countryUpdater.getActiveCountries();
      log.info('Active countries', activeCountries);
      for (const country of activeCountries) {
        await this.updateCountryAllocation(country)
        const category = countryUpdater.getCategory(country)
        await countryUpdater.refreshCategoryRecord(category)
        await countryUpdater.recycleIPSet(category)
      }
    } catch (err) {
      log.error("Failed to update conuntry sets", err)
    }
  }

  async getManagedTargetListInfo(category) {
    const infoHashsetId = `info:app.${category}`;
    try {
      const result = await bone.hashsetAsync(infoHashsetId);
      return JSON.parse(result);
    } catch (e) {
      log.error("Fail to fetch managed target list info:", category);
      return null;
    }
  }

  async updateCategory(category) {
    log.info(`Loading domains for ${category} from cloud`);

    const hashset = this.getCategoryHashset(category);

    let domains, info;
    if (category === "adblock_strict") {
      await categoryUpdater.updateStrategy(category, "adblock");
      info = {use_bf: true};
    } else if (categoryUpdater.isManagedTargetList(category)) {
      info = await this.getManagedTargetListInfo(category);
      log.debug(category, info);

      if (info && _.isObject(info) && (info.domain_count > 20000 || info.use_bf)) {
        await categoryUpdater.updateStrategy(category, "filter");
      } else {
        await categoryUpdater.updateStrategy(category, "default");
      }
    } else {
      await categoryUpdater.updateStrategy(category, "default");
    }

    let categoryStrategy = await categoryUpdater.getStrategy(category);

    if (!categoryStrategy.needOptimization) {
      // load user target list, enable port support
      if (categoryUpdater.isManagedTargetList(category)) {
        domains = await this.loadCategoryUsingCache(hashset);
      } else {
        domains = await this.loadCategoryFromBone(hashset);
      }
      if (domains == null) {
        log.error("Fail to fetch category list from cloud", category);
        return;
      }

      if (categoryUpdater.isUserTargetList(category) || categoryUpdater.isSmallExtendedTargetList(category) || (info && info.enable_v2))  {
        // in case of some categorys, such as doh, being converted to support tagret list with ports
        await categoryUpdater.flushDefaultDomains(category);
        await categoryUpdater.flushDefaultHashedDomains(category);
        await categoryUpdater.flushIPv4Addresses(category);
        await categoryUpdater.flushIPv6Addresses(category);
        // with port support
        await categoryUpdater.flushCategoryData(category);
        let categoryEntries = [];
        let totalDomainPortCount = 0;
        let totalIpPortCount = 0;
        for (const item of domains) {
          try {
            log.debug("Parse category entry:", item);
            const entries = CategoryEntry.parse(item);
            log.debug("Category entries", entries);
            for (const entry of entries) {
              if (entry.type === "domain") {
                totalDomainPortCount += entry.pcount;
              } else if (entry.type === "ipv4" || entry.type === "ipv6") {
                totalIpPortCount += entry.pcount;
              }
              categoryEntries.push(entry);
            }
          } catch (err) {
            log.error(err.message, item);
          }
        }
        log.debug(`Total domain port count: ${totalDomainPortCount}, total IP port count: ${totalIpPortCount}`);
        if (totalDomainPortCount > MAX_DOMAIN_PORT_COUNT  || totalIpPortCount > MAX_IP_PORT_COUNT) {
          log.error("Too much port match, disable category", category);
          categoryEntries = [];
        }
        await categoryUpdater.addCategoryData(category, categoryEntries);
      } else {
        // no port support
        const ip4List = domains.filter(d => new Address4(d).isValid());
        const ip6List = domains.filter(d => new Address6(d).isValid());
        const hashDomains = domains.filter(d => !ip4List.includes(d) && !ip6List.includes(d) && isHashDomain(d));
        const leftDomains = domains.filter(d => !ip4List.includes(d) && !ip6List.includes(d) && !isHashDomain(d));

        log.info(`category ${category} has ${ip4List.length} ipv4, ${ip6List.length} ipv6, ${leftDomains.length} domains, ${hashDomains.length} hashed domains`);

        await categoryUpdater.flushDefaultDomains(category);
        await categoryUpdater.flushDefaultHashedDomains(category);
        await categoryUpdater.flushIPv4Addresses(category);
        await categoryUpdater.flushIPv6Addresses(category);

        if (leftDomains.length > 20000) {
          log.error(`Domain count too large. Disable category ${category} in normal strategy.`);
        } else {
          if (leftDomains && leftDomains.length > 0) {
            await categoryUpdater.addDefaultDomains(category, leftDomains, this.config.regularInterval * 2);
          }
        }
        if (hashDomains && hashDomains.length > 0) {
          await categoryUpdater.addDefaultHashedDomains(category, hashDomains);
        }
        if (ip4List && ip4List.length > 0) {
          await categoryUpdater.addIPv4Addresses(category, ip4List);
        }
        if (ip6List && ip6List.length > 0) {
          await categoryUpdater.addIPv6Addresses(category, ip6List);
        }
      }
      await this.removeData(category);

    } else {
      // this category need optimization
      await categoryUpdater.flushDefaultDomains(category);
      await categoryUpdater.flushDefaultHashedDomains(category);
      await categoryUpdater.flushIPv4Addresses(category);
      await categoryUpdater.flushIPv6Addresses(category);

      if (!fc.isFeatureOn("category_filter")) {
        log.error(`Category filter feature not turned on. Category ${category} disabled.`);
        await categoryUpdater.updateStrategy(category, "default");
      } else {
        log.debug("Try to get filter data for category", category);
        if (!_.isObject(info)) {
          log.error(`Target list info of ${category} is unavailable, ignore it`);
          return;
        }
        // category may have multiple bloomfilter files, bf names are returned in "parts"
        const parts = _.isArray(info.parts) ? info.parts : [category];
        const prevParts = categoryUpdater.getCategoryBfParts(category);
        if (_.isEmpty(prevParts))
          prevParts.push(category); // this is for backward compatibility, parts is not supported before 1.981, so legacy data using category as bf name can be deleted if it is not included in parts now
        const removedParts = _.difference(prevParts, parts);
        log.info(`Current parts of category ${category} bf:`, parts);
        log.info(`Previous parts of category ${category} bf:`, prevParts);
        log.info(`Removed parts of category ${category} bf:`, removedParts);
        let updated = false;
        for (const part of removedParts) {
          const hashsetName = `bf:app.${part}`;
          await cloudcache.disableCache(hashsetName);
          await this.removeData(category).catch((err) => { });
          updated = true;
        }
        await categoryUpdater.setCategoryBfParts(category, parts);
        for (const part of parts) {
          const hashsetName = `bf:app.${part}`;
          let currentCacheItem = cloudcache.getCacheItem(hashsetName);
          if (currentCacheItem) {
            await currentCacheItem.download();
          } else {
            log.debug("Add category data item to cloud cache:", part);
            await cloudcache.enableCache(hashsetName);
            currentCacheItem = cloudcache.getCacheItem(hashsetName);
          }
          try {
            const content = await currentCacheItem.getLocalCacheContent();
            if (content) {
              updated = await this.updateData(part, content) || updated;
            } else {
              // remove obselete category data
              log.error(`Category ${category} part ${part} data is invalid. Remove it`);
              await this.removeData(part);
              updated = true;
            }
          } catch (e) {
            log.error(`Fail to update filter data for ${category}.`, e);
            return;
          }
        }
        if (updated) {
          const filterRefreshEvent = {
            type: "REFRESH_CATEGORY_FILTER",
            category: category,
            toProcess: "FireMain"
          };
          sem.emitEvent(filterRefreshEvent);
        } else {
          log.debug("Skip sending REFRESH_CATEGORY_FILTER event");
        }
      }
    }

    await this.updateDnsmasqConfig(category);

    const event = {
      type: "UPDATE_CATEGORY_DOMAIN",
      category,
      message: category,
    };
    sem.sendEventToAll(event);
  }

  // return true on successful update.
  // return false on skip.
  async updateData(category, content) {
    log.debug("Update category filter data", category);
    const obj = JSON.parse(content);
    if (!obj.data || !obj.info) {
      return false;
    }

    const filterFile = `${categoryUpdater.getCategoryFilterDir()}/${category}.data`;
    let currentFileContent;
    try {
      currentFileContent = await readFileAsync(filterFile);
    } catch (e) {
      currentFileContent = null;
    }

    const buf = Buffer.from(obj.data, "base64");
    if (currentFileContent && buf.equals(currentFileContent)) {
      log.debug(`No filter update for ${category}, skip`);
      return false;
    }

    await writeFileAsync(`${categoryUpdater.getCategoryFilterDir()}/${category}.data`, buf);
    const uid = `category:${category}`;
    const meta = {
      uid: uid,
      size: obj.info.s,
      error: obj.info.e,
      checksum: obj.info.checksum,
      path: `${category}.data`
    };
    await rclient.hsetAsync(CATEGORY_DATA_KEY, uid, JSON.stringify(meta));

    const updateEvent = {
      type: "update",
      msg: {
        uid: uid
      }
    };
    await rclient.publishAsync(INTEL_PROXY_CHANNEL, JSON.stringify(updateEvent));
    return true;
  }

  async removeData(category) {
    log.debug("Remove category filter data", category);
    const uid = `category:${category}`;
    await rclient.hdelAsync(CATEGORY_DATA_KEY, uid);

    const filterFile = `${categoryUpdater.getCategoryFilterDir()}/${category}.data`;
    await exec(`rm -fr ${filterFile}`);
  }

  async updateDnsmasqConfig(category) {
    const strategy = await categoryUpdater.getStrategy(category);
    if (strategy.dnsmasq.useFilter) {
      const parts = categoryUpdater.getCategoryBfParts(category);
      const meta = {};
      for (const part of parts) {
        const key = `category:${part}`;
        const partMeta = await rclient.hgetAsync(CATEGORY_DATA_KEY, key);
        if (partMeta)
          meta[part] = JSON.parse(partMeta);
        else
          log.error(`No bf data found for part ${part} of category ${category}`);
      }
      if (!_.isEmpty(meta)) {
        await dnsmasq.createCategoryFilterMappingFile(category, meta);
      } else {
        log.error(`No bf data. Delete dns filter config for category: ${category}`);
        await dnsmasq.deletePolicyCategoryFilterEntry(category);
      }
    } else {
      await dnsmasq.createCategoryMappingFile(category, [categoryUpdater.getIPSetName(category), `${categoryUpdater.getIPSetNameForIPV6(category)}`]);
    }
    dnsmasq.scheduleRestartDNSService();
  }

  async updateSecurityCategory(category) {
    log.info(`Loading security info for ${category} from cloud`);

    const hashset = securityHashMapping[category]
    const info = await this.loadCategoryFromBone(hashset);
    if (info == null) return

    const domains = info.domain
    const ip4List = info["ip4"]
    const ip6List = info["ip6"]

    const domainOnly = info["domainOnly"]
    const hashedDomains = info["hashedDomains"]

    log.info(`category ${category} has ${(ip4List || []).length} ipv4,`
      + ` ${(ip6List || []).length} ipv6, ${(domains || []).length} domains,`
      + ` ${(domainOnly || []).length} domainOnly, ${(hashedDomains || []).length} hashedDomains,`)

    await categoryUpdater.flushDefaultDomainsOnly(category);
    await categoryUpdater.flushDefaultHashedDomains(category);
    await categoryUpdater.flushDefaultDomains(category);
    await categoryUpdater.flushIPv4Addresses(category)
    await categoryUpdater.flushIPv6Addresses(category)
    if (domainOnly && domainOnly.length > 0) {
      await categoryUpdater.addDefaultDomainsOnly(category, domainOnly, this.config.securityInterval * 2);
    }

    if (hashedDomains && hashedDomains.length > 0) {
      await categoryUpdater.addDefaultHashedDomains(category, hashedDomains);
    }

    if (domains && domains.length > 0) {
      await categoryUpdater.addDefaultDomains(category, domains, this.config.securityInterval * 2);
    }

    if (ip4List && ip4List.length > 0) {
      await categoryUpdater.addIPv4Addresses(category, ip4List)
    }

    if (ip6List && ip6List.length > 0) {
      await categoryUpdater.addIPv6Addresses(category, ip6List)
    }

    const event = {
      type: "UPDATE_CATEGORY_DOMAIN",
      category,
      message: category,
    };
    sem.sendEventToAll(event);
  }

  async updateCountryAllocation(country) {
    const category = countryUpdater.getCategory(country);
    log.info(`Loading country ip allocation list for ${country} from cloud`);

    const ip4List = await this.loadCategoryFromBone(category + ':ip4');

    if (ip4List) {
      await countryUpdater.addAddresses(country, false, ip4List)
    }

    log.info(`Country ${country} has ${(ip4List || []).length} ipv4 entries`);

    if (fc.isFeatureOn('ipv6')) {
      const ip6List = await this.loadCategoryFromBone(category + ':ip6');

      if (ip6List) {
        await countryUpdater.addAddresses(country, true, ip6List)
      }

      log.info(`Country ${country} has ${(ip6List || []).length} ipv6 entries`)
    }
  }

  run() {
    void execSync(`mkdir -p ${categoryUpdater.getCategoryFilterDir()}`);

    sem.once('IPTABLES_READY', async () => {
      // initial round of country list update is triggered by this event
      // also triggers dynamic list and ipset update here
      // to make sure blocking takes effect immediately
      sem.on('Policy:CountryActivated', async (event) => {
        try {
          await this.updateCountryAllocation(event.country)
          const category = countryUpdater.getCategory(event.country)
          await countryUpdater.refreshCategoryRecord(category)
          await countryUpdater.recycleIPSet(category, false)
        } catch (err) {
          log.error("Failed to update conuntry set", event.country, err)
        }
      });

      sem.on('Policy:CategoryActivated', async (event) => {
        const category = event.category;
        const reloadFromCloud = event.reloadFromCloud;
        if (reloadFromCloud !== false && !categoryUpdater.isCustomizedCategory(category)) {
          if (securityHashMapping.hasOwnProperty(category)) {
            await this.updateSecurityCategory(category);
          } else {
            const categories = Object.keys(this.categoryHashsetMapping);
            if (!categories.includes(category)) {
              this.categoryHashsetMapping[category] = `app.${category}`;
            }
            await this.updateCategory(category);
          }
        } else {
          // only send UPDATE_CATEGORY_DOMAIN event for customized category or reloadFromCloud is false, which will trigger ipset/tls set refresh in CategoryUpdater.js
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category,
            message: category,
          };
          sem.sendEventToAll(event);
        }
      });

      sem.on('Categorty:ReloadFromBone', (event) => {
        const category = event.category;
        if (!categoryUpdater.isCustomizedCategory(category) &&
          (categoryUpdater.isActivated(category) || categoryUpdater.isTLSActivated(category))) {
          sem.emitEvent({
            type: "Policy:CategoryActivated",
            toProcess: "FireMain",
            message: "Category ReloadFromBone: " + category,
            category: category,
            reloadFromCloud: true
          });
        }
      });

      sem.on('Category:Delete', async (event) => {
        log.info("Deactivate category", event.category);
        const category = event.category;
        if (!categoryUpdater.isCustomizedCategory(category) &&
          categoryUpdater.activeCategories[category]) {
          delete categoryUpdater.activeCategories[category];
          delete this.categoryHashsetMapping[category];
          await categoryUpdater.flushDefaultDomains(category);
          await categoryUpdater.flushDefaultHashedDomains(category);
          await categoryUpdater.flushIPv4Addresses(category);
          await categoryUpdater.flushIPv6Addresses(category);
          await dnsmasq.deletePolicyCategoryFilterEntry(category);
          // handle related ipset?
        }
      })

      // this flushes all category related stuff, including customized category and country
      sem.on('Category:Flush', async () => {
        try {
          categoryUpdater.resetUpdaterState()
          countryUpdater.resetActiveCountries()
          this.resetCategoryHashsetMapping()

          const categoryKeys = (await rclient.scanResults('category:*'))
            .concat(await rclient.scanResults('dynamicCategoryDomain:*'))
            .concat(await rclient.scanResults('dynamicCategory:*'))     // country
            .concat(await rclient.scanResults('customized_category:*')) // qos
          categoryKeys.length && await rclient.unlinkAsync(categoryKeys)

          await dnsmasq.flushCategoryFilters()

          log.info('Category:Flush done')
        } catch (err) {
          log.error('Failed flushing', err)
        }
      })

      await this.regularJob()
      await this.securityJob()
      await this.renewCountryList()

      setInterval(this.regularJob.bind(this), this.config.regularInterval * 1000)

      setInterval(this.securityJob.bind(this), this.config.securityInterval * 1000)

      setInterval(this.countryJob.bind(this), this.config.countryInterval * 1000)

      sem.emitLocalEvent({
        type: "CategoryUpdateSensorReady",
      });
    })
  }

  async loadCategoryFromBone(hashset) {
    if (hashset) {
      let data
      try {
        data = await bone.hashsetAsync(hashset)
        const list = JSON.parse(data)
        return list
      } catch (err) {
        log.error("Failed to get hashset", err.message);
        return null;
      }
    } else {
      return null
    }
  }

  async loadCategoryUsingCache(hashsetId) {
    if (!hashsetId) {
      return null;
    }
    try {
      let item = cloudcache.getCacheItem(hashsetId);
      let r;
      if (!item) {
        r = await cloudcache.enableCache(hashsetId);
        item = cloudcache.getCacheItem(hashsetId);
      } else {
        r = await item.download();
      }
      if (r) {
        const data = await item.getLocalCacheContent();
        return JSON.parse(data);
      } else {
        log.info(`No local and remote checksum for category ${hashsetId}, disable cloud cache`);
        return (await this.loadCategoryFromBone(hashsetId));
      }
    } catch (err) {
      log.error(`Fail to load category hashset`, hashsetId, err);
      return null;
    }
  }

  getCategoryHashset(category) {
    return this.categoryHashsetMapping[category]
  }

  async renewCountryList() {
    const countryList = await this.loadCategoryFromBone('country:list');
    if (countryList == null) return

    await rclient.unlinkAsync('country:list');
    if (countryList.length) {
      await rclient.saddAsync('country:list', countryList);
    }
  }

  async updateFlowSignatureList(forceReload = false) {
    const pervFlowSignatureConfig = this.flowSignatureConfig || {};
    let flowSignatureConfig = await rclient.getAsync(Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);
    this.flowSignatureConfig = flowSignatureConfig;
    if (_.isEmpty(flowSignatureConfig) || forceReload) {
      flowSignatureConfig = await bone.hashsetAsync(Constants.REDIS_KEY_FLOW_SIGNATURE_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
      if (!_.isEmpty(flowSignatureConfig) && _.isObject(flowSignatureConfig)) {
        await rclient.setAsync(Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG, JSON.stringify(flowSignatureConfig));
        this.flowSignatureConfig = flowSignatureConfig;
      }
    }
    if (this.flowSignatureConfig && !_.isEqual(pervFlowSignatureConfig, this.flowSignatureConfig)){
      sem.emitEvent({
        type: "FlowSignatureListUpdated",
        toProcess: "FireMain"
      });
    }
  }

}

module.exports = CategoryUpdateSensor;
