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

const domainBlock = require('../control/DomainBlock.js');
const { isHashDomain } = require('../util/util.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const platform = require('../platform/PlatformLoader.js').getPlatform();

const { Readable, Transform, pipeline } = require('stream');
const util = require('util');
const pipelineAsync = util.promisify(pipeline);

const fs = require('fs');
const exec = require('child-process-promise').exec;
const { execSync } = require('child_process');
const scheduler = require('../util/scheduler');
const cloudcache = require('../extension/cloudcache/cloudcache');
const writeFileAsync = util.promisify(fs.writeFile);

const INTEL_PROXY_CHANNEL = "intel_proxy";

const categoryHashsetMapping = {
  "games": "app.gaming",
  "social": "app.social",
  "av": "app.video",
  "porn": "app.porn",  // dnsmasq redirect to blue hole if porn
  "gamble": "app.gamble",
  "p2p": "app.p2p",
  "vpn": "app.vpn"
}

const securityHashMapping = {
  "default_c": "blockset:default:consumer"
}

const CATEGORY_DATA_KEY = "intel_proxy.data";

class CategoryUpdateSensor extends Sensor {

  async regularJob() {
    try {
      const categories = Object.keys(categoryHashsetMapping)
      log.info('Native categories', categories);
      for (const category of categories) {
        await this.updateCategory(category);
      }
    } catch (err) {
      log.error("Failed to update categories", err)
    }
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

  async updateCategory(category) {
    log.info(`Loading domains for ${category} from cloud`);

    const hashset = this.getCategoryHashset(category);
    const domains = await this.loadCategoryFromBone(hashset);
    if (domains == null) return;
    const ip4List = domains.filter(d => new Address4(d).isValid());
    const ip6List = domains.filter(d => new Address6(d).isValid());
    const hashDomains = domains.filter(d => !ip4List.includes(d) && !ip6List.includes(d) && isHashDomain(d));
    const leftDomains = domains.filter(d => !ip4List.includes(d) && !ip6List.includes(d) && !isHashDomain(d));

    const categoryMeta = {
      id: category,
      size: domains.length,
      domainCount: leftDomains.length
    };

    await categoryUpdater.updateMeta(category, categoryMeta);

    const categoryStrategy = await categoryUpdater.getStrategy(category);

    log.info(`category ${category} has ${ip4List.length} ipv4, ${ip6List.length} ipv6, ${leftDomains.length} domains, ${hashDomains.length} hashed domains`);

    await categoryUpdater.flushDefaultDomains(category);
    await categoryUpdater.flushDefaultHashedDomains(category);
    await categoryUpdater.flushIPv4Addresses(category);
    await categoryUpdater.flushIPv6Addresses(category);

    if (categoryStrategy.storeRedis) {
      if (leftDomains && leftDomains.length > 0) {
        await categoryUpdater.addDefaultDomains(category, leftDomains);
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

    if (categoryStrategy.needOptimization) {
      const hashsetName = `bf:app.${category}`;
      let currentCacheItem = cloudcache.getCacheItem(hashsetName);
      if (currentCacheItem) {
        await currentCacheItem.download();
      } else {
        log.debug("Add category data item to cloud cache:", category);
        await cloudcache.enableCache(hashsetName);
        currentCacheItem = cloudcache.getCacheItem(hashsetName);
      }
      const content = await currentCacheItem.getLocalCacheContent();
      await this.updateData(category, content);
    }

    await this.updateDnsmasqConfig(category);

    // update list file
    if (categoryStrategy.storeFile) {
      log.debug("Create domain list file:", category);
      await this.createDomainList(category, domains);
    }

    const event = {
      type: "UPDATE_CATEGORY_DOMAIN",
      category: category
    };
    sem.sendEventToAll(event);
    sem.emitLocalEvent(event);

    const filterRefreshEvent = {
      type: "REFRESH_CATEGORY_FILTER",
      category: category,
      toProcess: "FireMain"
    };
    sem.emitEvent(filterRefreshEvent);
  }

  async updateData(category, content) {
    log.info("Update category data", category);
    try {
      const obj = JSON.parse(content);
      if (!obj.data || !obj.info) {
        return;
      }
      const buf = Buffer.from(obj.data, "base64");
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

    } catch (e) {
      log.error(`Fail to update data for category ${category}`, e);
    }
  }

  async updateDnsmasqConfig(category) {
    const strategy = await categoryUpdater.getStrategy(category);
    if (strategy.dnsmasq.useFilter) {
      const uid = `category:${category}`;
      const meta = await rclient.hgetAsync(CATEGORY_DATA_KEY, uid);
      if (meta) {
        await dnsmasq.createCategoryFilterMappingFile(category, JSON.parse(meta));
      } else {
        log.error("Fail to generate dns filter config for category:", category);
      }
    } else {
      await dnsmasq.createCategoryMappingFile(category, [categoryUpdater.getIPSetName(category), `${categoryUpdater.getIPSetNameForIPV6(category)}`]);
    }
    dnsmasq.scheduleRestartDNSService();
  }

  async createDomainList(category, domains) {
    const source = Readable.from(domains);
    const transform = new Transform({
      writableObjectMode: true,
      transform(chunk, encoding, callback) {
        this.push(chunk + "\n");
        callback();
      }
    });
    const fileName = `${categoryUpdater.getCategoryRawListDir()}/${category}.lst`;
    const tmpFileName = `${categoryUpdater.getCategoryRawListDir()}/${category}.lst.tmp`;

    try {
      await exec(`rm -f ${tmpFileName}`);
      const writeStream = fs.createWriteStream(tmpFileName);
      await pipelineAsync(source, transform, writeStream);
      await exec(`mv ${tmpFileName} ${fileName}`);
    } catch (e) {
      log.warn("Failed to create category list file:", category, e);
      await exec(`rm -f ${tmpFileName}`);
    }
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
      await categoryUpdater.addDefaultDomainsOnly(category, domainOnly);
    }

    if (hashedDomains && hashedDomains.length > 0) {
      await categoryUpdater.addDefaultHashedDomains(category, hashedDomains);
    }

    if (domains && domains.length > 0) {
      await categoryUpdater.addDefaultDomains(category, domains);
    }

    if (ip4List && ip4List.length > 0) {
      await categoryUpdater.addIPv4Addresses(category, ip4List)
    }

    if (ip6List && ip6List.length > 0) {
      await categoryUpdater.addIPv6Addresses(category, ip6List)
    }

    const event = {
      type: "UPDATE_CATEGORY_DOMAIN",
      category: category
    };
    sem.sendEventToAll(event);
    sem.emitLocalEvent(event);
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
    void execSync(`mkdir -p ${categoryUpdater.getCategoryRawListDir()}`);

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
            const categories = Object.keys(categoryHashsetMapping);
            if (!categories.includes(category)) {
              categoryHashsetMapping[category] = `app.${category}`;
            }
            await this.updateCategory(category)
          }
        } else {
          // only send UPDATE_CATEGORY_DOMAIN event for customized category or reloadFromCloud is false, which will trigger ipset/tls set refresh in CategoryUpdater.js
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category: category
          };
          sem.sendEventToAll(event);
          sem.emitLocalEvent(event);
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
        const category = event.category;
        if (!categoryUpdater.isCustomizedCategory(category) &&
          categoryUpdater.activeCategories[category]) {
          delete categoryUpdater.activeCategories[category];
          delete categoryHashsetMapping[category];
          await categoryUpdater.flushDefaultDomains(category);
          await categoryUpdater.flushDefaultHashedDomains(category);
          await categoryUpdater.flushIPv4Addresses(category);
          await categoryUpdater.flushIPv6Addresses(category);
          await dnsmasq.deletePolicyCategoryFilterEntry(category);
          // handle related ipset?
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
        log.error("Failed to get hashset, err:", err);
        return null;
      }
    } else {
      return null
    }
  }

  getCategoryHashset(category) {
    return categoryHashsetMapping[category]
  }

  async renewCountryList() {
    const countryList = await this.loadCategoryFromBone('country:list');
    if (countryList == null) return

    await rclient.delAsync('country:list');
    if (countryList.length) {
      await rclient.saddAsync('country:list', countryList);
    }
  }
}

module.exports = CategoryUpdateSensor;
