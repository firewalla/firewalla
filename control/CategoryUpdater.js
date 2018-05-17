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

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js')

const fc = require('../net2/config.js')

const exec = require('child-process-promise').exec

let instance = null

const EXPIRE_TIME = 60 * 60 * 48 // one hour

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

class CategoryUpdater {

  constructor() {
    if (instance == null) {
      instance = this
      this.activeCategories = {
        "games": 1,
        "social": 1,
        "porn": 1,
        "shopping": 1
      }

      setInterval(() => {
        this.refreshAllCategoryRecords()
      }, 60 * 60 * 1000) // update records every hour
    }
    return instance
  }

  getCategoryKey(category) {
    return `dynamicCategoryDomain:${category}`
  }

  async getDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.zrangeAsync(this.getCategoryKey(category), 0, -1)
  }

  async getDomainsWithExpireTime(category) {
    const key = this.getCategoryKey(category)

    const domainAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores')
    const results = []

    for(let i = 0; i < domainAndScores.length; i++) {
      if(i % 2 === 1) {
        const domain = domainAndScores[i-1]
        const score = Number(domainAndScores[i])
        const expireDate = score + EXPIRE_TIME

        results.push({domain: domain, expire: expireDate})
      }
    }

    return results
  }

  async updateDomain(category, domain) {

    if(!this.isActivated(category)) {
      log.info(`category ${category} is not updated`)
      return
    }


    const now = Math.floor(new Date() / 1000)
    const key = this.getCategoryKey(category)
    await rclient.zaddAsync(key, now, domain) // use current time as score for zset, it will be used to know when it should be expired out
    await this.updateIPSetByDomain(category, domain, {})
  }
  
  getMapping(category) {
    return `cuip:${category}`
  }
  
  async updateDomainIPMapping(category, domain) {
    const domainBlock = require('./DomainBlock.js')()
    domainBlock.externalMapping = this.getMapping(category)
    
    // resolve this domain and add resolved ip addresses to the given mapping pool
    // e.g. cuip:games
    // the ip addresses in this pool will dynamically added and cleaned up periodically
    domainBlock.syncDomainIPMapping(domain, {
      exactMatch: true
    })
  }

  getIPSetName(category) {
    return `c_category_${category}`
  }
  
  getIPSetNameForIPV6(category) {
    return `c_category6_${category}`
  }

  getTempIPSetName(category) {
    return `c_tmp_category_${category}`
  }

  getTempIPSetNameForIPV6(category) {
    return `c_tmp_category6_${category}`
  }
  
  async updateIPSet(category, options) {
    const mapping = this.getMapping(category)
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)
    
    let cmd4 = `redis-cli smembers ${mapping} | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
    let cmd6 = `redis-cli smembers ${mapping} | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
    return (async () => {
      await exec(cmd4)
      await exec(cmd6)
    })()
  }
  
  getDomainMapping(domain) {
    return `rdns:domain:${domain}`
  }
  
  async updateIPSetByDomain(category, domain, options) {
    const mapping = this.getDomainMapping(domain)
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    let cmd4 = `redis-cli zrange ${mapping} 0 -1 | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
    let cmd6 = `redis-cli zrange ${mapping} 0 -1 | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
    return (async () => {
      await exec(cmd4)
      await exec(cmd6)
    })().catch((err) => {
      log.error(`Failed to update ipset by category ${category} domain ${domain}, err: ${err}`)
    })
  }
  
  async recycleIPSet(category, options) {
    const domains = await this.getDomains(category)

    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)
    const tmpIPSetName = this.getTempIPSetName(category)
    const tmpIPSet6Name = this.getTempIPSetNameForIPV6(category)

    await Promise.all(domains.map(async (domain) => {
      const cmd4 = `redis-cli zrange ${mapping} 0 -1 | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      const cmd6 = `redis-cli zrange ${mapping} 0 -1 | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
      return (async () => {
        await exec(cmd4)
        await exec(cmd6)
      })().catch((err) => {
        log.error(`Failed to update temp ipset by category ${category} domain ${domain}, err: ${err}`)
      })
    }))

    // swap temp ipset with ipset
    const swapCmd = `sudo ipset swap ${ipsetName} ${tmpIPSetName}`
    const swapCmd6 = `sudo ipset swap ${ipset6Name} ${tmpIPSet6Name}`

    (async () => {
      await exec(swapCmd)
      await exec(swapCmd6)
    })().catch((err) => {
      log.error(`Failed to swap ipsets for category ${category}, err: ${err}`)
    })

    const flushCmd = `sudo ipset flush ${tmpIPSetName}`
    const flushCmd6 = `sudo ipset flush ${tmpIPSet6Name}`

    (async () => {
      await exec(flushCmd)
      await exec(flushCmd6)
    })().catch((err) => {
      log.error(`Failed to flush temp ipsets for category ${category}, err: ${err}`)
    })

    log.info(`Successfully recycled ipset for category ${category}`)
  }

  async deleteCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    return rclient.delAsync(key)
  }

  getCategories() {
    return Object.keys(this.activeCategories)
  }

  activateCategory(category) {
    this.activeCategories[category] = 1
  }

  async disactivateCategory(category) {
    delete this.activeCategories[category]
    await this.deleteCategoryRecord(category)
  }

  isActivated(category) {
    // always return true for now
    return this.activeCategories[category] !== undefined
  }

  async refreshCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

    return rclient.zremrangebyscoreAsync(key, '-inf', date)
  }

  async refreshAllCategoryRecords() {
    await Promise.all(this.getCategories().map(async (category) => {
      await this.refreshCategoryRecord(category) // refresh domain list for each category
      await this.recycleIPSet(category) // sync refreshed domain list to ipset
    }))
  }

}

module.exports = CategoryUpdater
