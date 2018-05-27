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
  // "video": "app.video",
  "porn": "app.porn"  // dnsmasq redirect to blue hole if porn
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
  }

  async updateCategory(category) {
    const domains = await this.loadCategoryFromBone(category);
    await categoryUpdater.flushDefaultDomains(category);
    return categoryUpdater.addDefaultDomains(category,domains);
  }

  run() {
    this.job()

    setInterval(() => {
      this.job()
    }, this.config.refreshInterval)
  }

  async loadCategoryFromBone(category) {
    const hashset = this.getCategoryHashset(category)

    if(hashset) {
      log.info(`Loading domains for ${category} from cloud`);
      const data = await bone.hashsetAsync(hashset)
      const list = JSON.parse(data)
      log.info(`category ${category} has ${list.length} domains`)
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
