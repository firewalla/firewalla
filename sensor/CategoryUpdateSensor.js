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
  "p2p": "app.p2p"
}

const securityHashMapping = {
  "default_c": "blockset:default:consumer"
}

class CategoryUpdateSensor extends Sensor {

  async regularJob() {
    const categories = Object.keys(categoryHashsetMapping)
    for (const category of categories) {
      await this.updateCategory(category);
    }
  }

  async securityJob() {
    const securityCategories = Object.keys(securityHashMapping)
    for (const category of securityCategories) {
      await this.updateSecurityCategory(category)
    }
  }

  async countryJob() {
    const countryList = this.loadCategoryFromBone('country:list');
    rc.saddAsync('', countryList);
    
    const activeCountries = countryUpdater.getActiveCountries();
    log.info('Active countries', activeCountries);
    for (const country of activeCountries) {
      await this.updateCountryAllocation(country)
      const category = countryUpdater.getCategory(country)
      await countryUpdater.refreshCategoryRecord(category)
      await countryUpdater.recycleIPSet(category)
    }
  }

  async updateCategory(category) {
    log.info(`Loading domains for ${category} from cloud`);

    const hashset = this.getCategoryHashset(category)
    const domains = await this.loadCategoryFromBone(hashset);
    log.info(`category ${category} has ${domains.length} domains`)

    await categoryUpdater.flushDefaultDomains(category);
    return categoryUpdater.addDefaultDomains(category,domains);
  }

  async updateSecurityCategory(category) {
    log.info(`Loading security info for ${category} from cloud`);

    const hashset = securityHashMapping[category]
    const info = await this.loadCategoryFromBone(hashset);

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
      await this.regularJob()
      await this.securityJob()

      // initial round of country list update is triggered by this event
      // also triggers dynamic list and ipset update here
      // to make sure blocking takes effect immediately
      sem.on('Policy:CountryActivated', async (event) => {
        await this.updateCountryAllocation(event.country)
        const category = countryUpdater.getCategory(event.country)
        await countryUpdater.refreshCategoryRecord(category)
        await countryUpdater.recycleIPSet(category, false)
      })

      setInterval(this.regularJob, this.config.regularInterval * 1000)

      setInterval(this.securityJob, this.config.securityInterval * 1000)

      setInterval(this.countryJob, this.config.countryInterval * 1000)
    })
  }

  async loadCategoryFromBone(hashset) {
    if (hashset) {
      try {
        const data = await bone.hashsetAsync(hashset)
        const list = JSON.parse(data)
        return list
      } catch(err) {
        log.error("Failed to get hashset", hashset, err);
        return []
      }
    } else {
      return []
    }
  }

  getCategoryHashset(category) {
    return categoryHashsetMapping[category]
  }
}

module.exports = CategoryUpdateSensor;
