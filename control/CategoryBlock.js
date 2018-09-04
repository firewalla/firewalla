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
const Promise = require('bluebird');

const rclient = require('../util/redis_manager.js').getRedisClient()

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js')

const fc = require('../net2/config.js')

const exec = require('child-process-promise').exec

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const categoryHashsetMapping = {
  "games": "app.gaming",
  "social": "app.social",
  "video": "app.video",
  "porn": "app.porn"  // dnsmasq redirect to blue hole if porn
}

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

class CategoryBlock {

  constructor() {

  }

  async blockCategory(category, options) {
    options = options || {}
    
    // this policy has scope
    if(options.macSet) {
//      await categoryUpdater.iptablesBlockCategoryPerDevice(category, options.macSet);
      await categoryUpdater.iptablesBlockCategoryPerDeviceNew(category, options.macSet);
    } else {
      // global policy
      await categoryUpdater.iptablesBlockCategory(category)

      if(category === 'default_c') {
        await categoryUpdater.iptablesRedirectCategory(category).catch((err) => {
          log.error("Failed to redirect default_c traffic, err", err)
        })
      }
    }
  }

  async unblockCategory(category, options) {
    options = options || {}

    // this policy has scope
    if(options.macSet) {
      // TBD
//      await categoryUpdater.iptablesUnblockCategoryPerDevice(category, options.macSet);
      await categoryUpdater.iptablesUnblockCategoryPerDeviceNew(category, options.macSet);
    } else {
      // global policy
      await categoryUpdater.iptablesUnblockCategory(category)

      if(category === 'default_c') {
        await categoryUpdater.iptablesUnredirectCategory(category).catch((err) => {
          log.error("Failed to unredirect default_c traffic, err", err)
        })
      }
    }
    
  }
  
}

module.exports = () => new CategoryBlock()
