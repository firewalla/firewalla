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

const redis = require('redis');
const rclient = redis.createClient();

Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js')

const fc = require('../net2/config.js')

const categoryHashsetMapping = {
  "games": "app.gaming",
  "social": "app.social",
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

  blockCategory(category, options) {
    options = options || {}

    const domainBlock = require('./DomainBlock.js')()
    domainBlock.externalMapping = this.getMapping(category)

    return async(() => {
      const list = await (this.loadCategoryFromBone(category))
      if(list && list.length > 0) {
        await (this.saveDomains(category, list)) // used for unblock
        list.forEach((domain) => {
          let options = {ignoreApplyBlock: true}
          if(category === "porn" && fc.isFeatureOn("porn_redirect")) {
            options.use_blue_hole = true
          }
          await (domainBlock.blockDomain(domain, options).catch((err) => undefined)) // may need to provide options argument in the future
        })
        await (domainBlock.applyBlock("", options)) // this will create ipset rules
      }
    })()
  }

  unblockCategory(category, options) {
    options = options || {}

    const domainBlock = require('./DomainBlock.js')()
    domainBlock.externalMapping = this.getMapping(category)

    return async(() => {
      if(!options.ignoreUnapplyBlock) {
        await (domainBlock.unapplyBlock("", options).catch((err) => undefined)) // this will remove ipset rules
      }

      const list = await (this.loadDomains(category))
      if(list && list.length > 0) {
        list.forEach((domain) => {
          await (domainBlock.unblockDomain(domain, {ignoreUnapplyBlock: true}).catch((err) => undefined)) // may need to provide options argument in the future
        })
      }
      await (rclient.delAsync(this.getMapping(category))) // ipmapping:category:games
      await (rclient.delAsync(this.getCategoryDomainKey(category))) // categoryDomain:games
    })()
  }

  loadDomains(category) {
    return async(() => {
      const key = this.getCategoryDomainKey(category)
      return rclient.smembersAsync(key)
    })()
  }

  saveDomains(category, list) {
    return async(() => {
      const key = this.getCategoryDomainKey(category)
      await (rclient.saddAsync(key, list))
    })()
  }

  getCategoryDomainKey(category) {
    return `categoryDomain:${category}`
  }

  getCategoryHashset(category) {
    return categoryHashsetMapping[category]
  }

  getMapping(category) {
    return `ipmapping:category:${category}`
  }

  loadCategoryFromBone(category) {
    const hashset = this.getCategoryHashset(category)

    return async(() => {
      if(hashset) {
        log.info(`Loading domains for ${category} from cloud`);
        const data = await (bone.hashsetAsync(hashset))
        const list = JSON.parse(data)
        log.info(`${list.length} domains are found`)
        return list.map((l) => l.replace("*.", "")) // convert it to domain style    *.facebook.com => facebook.com
      } else {
        return []
      }
    })().catch((err) => {
      log.error(`Failed to load ${category} hash set from cloud`, err)
    })
  }
  
}

module.exports = () => new CategoryBlock()
