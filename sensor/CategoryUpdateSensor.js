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

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js');

const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();

const categoryHashsetMapping = {
  "games": "app.gaming",
  "social": "app.social",
  "av": "app.video",
  "porn": "app.porn"  // dnsmasq redirect to blue hole if porn
}

const securityHashMapping = {
  "default_c": "blockset:default:consumer"
}

class CategoryUpdateSensor extends Sensor {
  constructor() {
    super();
    this.config.refreshInterval = 8 * 3600 * 1000; // refresh every 8 hours
  }

  async job() {
    const categories = Object.keys(categoryHashsetMapping)
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      await this.updateCategory(category);
    }

    const securityCategories = Object.keys(securityHashMapping)
    for (let i = 0; i < securityCategories.length; i++) {
      const category = securityCategories[i]
      await this.updateSecurityCategory(category)
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
      + ` ${(ip6List || []).length} ipv6, ${(domain || []).length} domains`)

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

  run() {
    this.job()

    setInterval(() => {
      this.job()
    }, this.config.refreshInterval)
  }

  async loadCategoryFromBone(category) {
    if (hashset) {
      const data = await bone.hashsetAsync(hashset)
      const list = JSON.parse(data)
      return list
    } else {
      return []
    }
  }

  getCategoryHashset(category) {
    return categoryHashsetMapping[category]
  }
}

module.exports = CategoryUpdateSensor;
