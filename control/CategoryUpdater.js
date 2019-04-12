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

const log = require("../net2/logger.js")(__filename);

const CategoryUpdaterBase = require('./CategoryUpdaterBase.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

let instance = null

const _ = require('lodash');

class CategoryUpdater extends CategoryUpdaterBase {

  constructor() {
    if (instance == null) {
      super()

      instance = this

      this.activeCategories = {
        "games": 1,
        "social": 1,
        "porn": 1,
        "shopping": 1,
        "av": 1,
        "default_c": 1,
        "p2p": 1,
        "gamble": 1
      }

      // only run refresh category records for fire main process
      if (process.title === 'FireMain') {
        setInterval(() => {
          this.refreshAllCategoryRecords()
        }, 60 * 60 * 1000) // update records every hour

        setTimeout(async () => {

          log.info("============= UPDATING CATEGORY IPSET =============")
          await this.refreshAllCategoryRecords()
          log.info("============= UPDATING CATEGORY IPSET COMPLETE =============")

        }, 2 * 60 * 1000) // after two minutes

        sem.on('UPDATE_CATEGORY_DYNAMIC_DOMAIN', (event) => {
          if(event.category) {
            this.recycleIPSet(event.category)
          }
        });
      }
    }

    return instance
  }
}

module.exports = CategoryUpdater
