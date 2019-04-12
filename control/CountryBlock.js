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

const rclient = require('../util/redis_manager.js').getRedisClient()

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js')

const fc = require('../net2/config.js')

const exec = require('child-process-promise').exec

const CategoryUpdater = require('./CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const block = require('./Block.js');

const categoryBlock = require('../control/CategoryBlock.js')()

class CountryBlock {

  static async blockDomain(domain, options) {
    options = options || {}


    await this.syncDomainIPMapping(domain, options)
    domainUpdater.registerUpdate(domain, options);
    if(!options.ignoreApplyBlock) {
      await this.applyBlock(domain, options);
    }
  }

  static getCategroy(code) {
    return `country:${code.toUpperCase}`;
  }

  static async blockCountry(code, options) {
    const category = this.getCategroy(code);
    // setup list


    await categoryBlock.blockCategory(category, options)
  }

  static async unblockCountry(code, options) {
    const category = this.getCategroy(code);

    await categoryBlock.unblockCategory(category, options)
  }

  static async applyBlock(code) {
    if(subnets) {
      for (const addr of subnets) {
        await block.block(addr, blockSet).catch(err => {});
      }
    }
  }

}

module.exports = CountryBlock
