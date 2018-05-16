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

const EXPIRE_TIME = 60 * 60 // one hour

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

class CategoryUpdater {

  constructor() {
    if (instance == null) {
      instance = this
      this.activeCategories = {}

      setInterval(() => {
        this.refreshAllCategoryRecords()
      }, 5 * 60 * 1000) // update records every 5 minutes
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
        const score = domainAndScores[i]
        const expireDate = score + EXPIRE_TIME

        results.push({domain: domain, expire: expireDate})
      }
    }

    return results
  }

  async updateDomain(category, domain) {
    if(!this.isActivated(category))
      return

    const now = Math.floor(new Date() / 1000)
    const key = this.getCategoryKey(category)
    await rclient.zaddAsync(key, now, domain) // use current time as score for zset, it will be used to know when it should be expired out
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
    return this.activeCategories[category] !== undefined
  }

  async refreshCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

    return rclient.zremrangebyscoreAsync(key, '-inf', date)
  }

  async refreshAllCategoryRecords() {
    this.getCategories().forEach((category) => {
      await this.refreshCategoryRecord(category)
    })
  }

}

module.exports = CategoryUpdater
