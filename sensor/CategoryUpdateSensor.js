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

class CategoryUpdateSensor extends Sensor {

  async regularJob() {
    try {
      const categories = Object.keys(categoryHashsetMapping)
      log.info('Native categories', categories);
      for (const category of categories) {
        await this.updateCategory(category);
      }
    } catch(err) {
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
    } catch(err) {
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
    } catch(err) {
      log.error("Failed to update conuntry sets", err)
    }
  }

  async updateCategory(category) {
    log.info(`Loading domains for ${category} from cloud`);

    const hashset = this.getCategoryHashset(category)
    const domains = await this.loadCategoryFromBone(hashset);
    if (domains == null) return
    log.info(`category ${category} has ${domains.length} domains`)

    await categoryUpdater.flushDefaultDomains(category);
    return categoryUpdater.addDefaultDomains(category,domains);
  }

  async updateSecurityCategory(category) {
    log.info(`Loading security info for ${category} from cloud`);

    const hashset = securityHashMapping[category]
    const info = await this.loadCategoryFromBone(hashset);
    if (info == null) return

    const domains = info.domain
    const ip4List = info["ip4"]
    const ip6List = info["ip6"]

    log.info(`category ${category} has ${(ip4List || []).length} ipv4,`
      + ` ${(ip6List || []).length} ipv6, ${(domains || []).length} domains`)

    // if (domains) {
    //   await categoryUpdater.flushDefaultDomains(category);
    //   await categoryUpdater.addDefaultDomains(category,domains);
    // }

    if (ip4List) {
      await categoryUpdater.flushIPv4Addresses(category)
      await categoryUpdater.addIPv4Addresses(category, ip4List)
    }

    if (ip6List) {
      await categoryUpdater.flushIPv6Addresses(category)
      await categoryUpdater.addIPv6Addresses(category, ip6List)
    }
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
    sem.once('IPTABLES_READY', async() => {
      // initial round of country list update is triggered by this event
      // also triggers dynamic list and ipset update here
      // to make sure blocking takes effect immediately
      sem.on('Policy:CountryActivated', async (event) => {
        try {
          await this.updateCountryAllocation(event.country)
          const category = countryUpdater.getCategory(event.country)
          await countryUpdater.refreshCategoryRecord(category)
          await countryUpdater.recycleIPSet(category, false)
        } catch(err) {
          log.error("Failed to update conuntry set", event.country, err)
        }
      });

      sem.on('Policy:CategoryActivated', async (event) => {
        const category = event.category;
        if (!categoryHashsetMapping[category]) {
          log.error(`Cannot activate unrecognized category ${category}`);
          return;
        }
        await categoryUpdater.refreshCategoryRecord(category).then(() => {
          return categoryUpdater.recycleIPSet(category)
        }).catch((err) => {
          log.error(`Failed to activate category ${category}`, err.message);
        });
      });

      await this.regularJob()
      await this.securityJob()
      await this.renewCountryList()

      setInterval(this.regularJob.bind(this), this.config.regularInterval * 1000)

      setInterval(this.securityJob.bind(this), this.config.securityInterval * 1000)

      setInterval(this.countryJob.bind(this), this.config.countryInterval * 1000)
    })
  }

  async loadCategoryFromBone(hashset) {
    if (hashset) {
      let data
      try {
        data = await bone.hashsetAsync(hashset)
        const list = JSON.parse(data)
        return list
      } catch(err) {
        log.error("Failed to get hashset", hashset, data, err);
        return null
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
