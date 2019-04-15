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

const Block = require('./Block.js');
const CategoryUpdaterBase = require('./CategoryUpdaterBase.js');

const exec = require('child-process-promise').exec

let instance = null

const EXPIRE_TIME = 60 * 60 * 48 // one hour

const iptool = require("ip");

const ACTIVE_COUNTRY_SET = 'category:country:list'

// CountryUpdater is responsible for updating dynamic ip/subnet
// presistent subnet set update is triggered in CategoryUpdateSensor
class CountryUpdater extends CategoryUpdaterBase {

  constructor() {
    if (instance == null) {
      super()
      instance = this

      this.init();
    }
    return instance
  }

  getCategory(code) {
    return `country:${code.toUpperCase()}`;
  }

  getDynamicIPv4Key(category) {
    return `dynamicCategory:${category}:ip4:net`
  }

  getDynamicIPv6Key(category) {
    return `dynamicCategory:${category}:ip6:net`
  }

  async getActiveCountries() {
    // return await rclient.smembersAsync(ACTIVE_COUNTRY_SET);
    return activeCountries
  }

  async init() {
    this.activeCountries = await rclient.smembersAsync(ACTIVE_COUNTRY_SET);
    this.activeCategories = {}
    for (const code of this.activeCountries) {
      const category = this.getCategory(code);
      this.activeCategories[category] = 1
      await Block.setupCategoryEnv(category, 'hash:net');
    }

    // only run refresh category records for fire main process
    if(process.title === 'FireMain') {
      setInterval(() => {
        this.refreshAllCategoryRecords()
      }, 24 * 60 * 60 * 1000) // update records every day

      setTimeout(async () => {

        log.info("============= UPDATING COUNTRY IPSET =============")
        await this.refreshAllCategoryRecords()
        log.info("============= UPDATING COUNTRY IPSET COMPLETE =============")

      }, 3 * 60 * 1000) // after 3 minutes
    }
  }

  // included/excluded ip/subnet should be implemented as exception rules

  async activateCountry(code) {
    const category = this.getCategory(code)

    await rclient.saddAsync(ACTIVE_COUNTRY_SET, code)

    this.activeCountries[code] = 1
    this.activeCategories[category] = 1
    await Block.setupCategoryEnv(category, 'hash:net');

    await this.refreshCategoryRecord(category)
  }

  async deactivateCountry(code) {
    const category = this.getCategory(code)

    await rclient.sremAsync(ACTIVE_COUNTRY_SET, code)

    delete this.activeCountries[code]
    await this.deactivateCategory(category)
  }

  async refreshCategoryRecord(category) {
    const getKey46 = [this.getDynamicIPv4Key, this.getDynamicIPv6Key]

    for (const getKey of getKey46) {
      const key = getKey(category)
      const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

      await rclient.zremrangebyscoreAsync(key, '-inf', date)
    }
  }

  async addDynamicEntries(category, options) {
    const getKey    = [this.getDynamicIPv4Key, this.getDynamicIPv6Key]
    const getSet    = [this.getIPSetName, this.getIPSet6Name]
    const getTmpSet = [this.getTempIPSetName, this.getTempIPSet6Name]

    for (let i = 0; i < 2; i++) {
      const key = getKey[i](category)
      const exists = await rclient.zcountAsync(key, '-inf', '+inf')

      if (exists) try {
        const ipsetName = options && options.useTemp ?
          getSet[i](category) :
          getTmpSet[i](category);
        const cmd = `redis-cli zrange ${key} 0 -1 | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
        await exec(cmd)
      } catch(err) {
        log.error(`Failed to update ipset for ${category}, cmd: ${cmd}, err: ${err}`)
      }
    }
  }

  async recycleIPSet(category) {

    if (!this.isActivated(category)) return

    await this.updatePersistentIPSets(category, {useTemp: true});

    await this.addDynamicEntries(category, {useTemp: true});

    await this.swapIpset(category);

    log.info(`Successfully recycled ipset for category ${category}`)
  }

  async updateIP(code, ip) {
    if(!code || !ip) {
      return;
    }

    const category = this.getCategory(code)

    if(!this.isActivated(category)) {
      return
    }

    const ipset = iptool.isV4Format(ip) ?
      this.getIPSetName(category) : 
      this.getIPSetNameForIPV6(category)

    const check = `sudo ipset test ${ipset} ${ip}`

    try {
      await exec(check)
    } catch(err) {
      if (err.stderr.indexOf(`is NOT in set ${ipset}`) > 0)
        await Block.block(ip, ipset);
    }
  }
}

module.exports = CountryUpdater
