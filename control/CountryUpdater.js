/*    Copyright 2019-2024 Firewalla Inc.
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

const firewalla = require("../net2/Firewalla.js");

const Block = require('./Block.js');
const CategoryUpdaterBase = require('./CategoryUpdaterBase.js');

const exec = require('child-process-promise').exec
const sem = require('../sensor/SensorEventManager.js').getInstance();

let instance = null

const EXPIRE_TIME = 60 * 60 * 48 // 2 days

const iptool = require("ip");

const util = require('util')
const fs = require('fs');
const writeFileAsync = util.promisify(fs.writeFile);

const Ipset = require('../net2/Ipset.js')

const DISK_CACHE_FOLDER = firewalla.getTempFolder() + '/country'

// CountryUpdater is responsible for updating dynamic ip/subnet
// presistent subnet set update is triggered in CategoryUpdateSensor
class CountryUpdater extends CategoryUpdaterBase {

  constructor() {
    if (instance == null) {
      super()
      this.inited = false;
      instance = this

      this.resetActiveCountries()
      exec(`mkdir -p ${DISK_CACHE_FOLDER}`);
      setInterval(async () => {
        if (firewalla.isMain()) {
          await Ipset.batchOp(this.batchOps).catch((err) => {
            log.error(`Failed to update country ipsets`, err.message);
          });
        }
        this.batchOps = [];
      }, 60000); // update country ipsets once every minute
    }

    return instance
  }

  getCategory(code) {
    return `country:${code.toUpperCase()}`;
  }

  getCountry(category) {
    return category.substring(8);
  }

  getDynamicIPv4Key(category) {
    return `dynamicCategory:${category}:ip4:net`
  }

  getDynamicIPv6Key(category) {
    return `dynamicCategory:${category}:ip6:net`
  }

  getActiveCountries() {
    return Object.keys(this.activeCountries);
  }

  // included/excluded ip/subnet should be implemented as exception rules

  async activateCountry(code) {
    if (this.activeCountries[code]) return

    const category = this.getCategory(code)

    this.activeCountries[code] = 1
    this.activeCategories[category] = 1
    // use a larger hash size for country ipset since some country ipset may be large and cause performance issue
    await Block.setupCategoryEnv(category, 'hash:net', 32768, false, true);

    sem.emitEvent({
      type: 'Policy:CountryActivated',
      toProcess: 'FireMain',
      message: 'Country activated: ' + code,
      country: code
    })
  }

  async deactivateCountry(code) {
    log.info(`Deactivating country ${code} ...`)
    const category = this.getCategory(code)

    await Ipset.destroy(this.getIPSetName(category))
    await Ipset.destroy(this.getIPSetNameForIPV6(category))
    await Ipset.destroy(this.getTempIPSetName(category))
    await Ipset.destroy(this.getTempIPSetNameForIPV6(category))

    delete this.activeCountries[code]
    await this.deactivateCategory(category)
  }

  resetActiveCountries() {
    this.activeCountries = {}
    this.activeCategories = {}
    this.batchOps = []
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
    const getSet    = [this.getIPSetName, this.getIPSetNameForIPV6]
    const getTmpSet = [this.getTempIPSetName, this.getTempIPSetNameForIPV6]

    for (let i = 0; i < 2; i++) {
      const key = getKey[i](category)
      const exists = await rclient.zcountAsync(key, '-inf', '+inf')

      const ipsetName = options && options.useTemp ?
        getTmpSet[i](category) :
        getSet[i](category)
      const cmd = `redis-cli zrange ${key} 0 -1 | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      log.debug('addDynamicEntries:', cmd)

      if (exists) try {
        await exec(cmd)
      } catch(err) {
        log.error(`Failed to update ipset for ${category}, cmd: ${cmd}`, err)
      }
    }
  }

  async updateIpset(category, ip6 = false, options) {

    let ipsetName = ip6 ? this.getIPSetNameForIPV6(category) : this.getIPSetName(category)

    if(options && options.useTemp) {
      ipsetName = ip6 ? this.getTempIPSetNameForIPV6(category) : this.getTempIPSetName(category)
    }

    const country = this.getCountry(category);
    const file = DISK_CACHE_FOLDER + `/${country}.ip${ip6?6:4}`;

    try {
      await exec(`sudo ipset flush ${ipsetName}`)
      let cmd4 = `cat ${file} | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      await exec(cmd4)
    } catch(err) {
      log.error(`Failed to update ipset by category ${category} with ipv${ip6?6:4} addresses`, err)
    }
  }

  async addAddresses(country, ip6 = false, addresses) {
    if (!country || !this.isActivated(this.getCategory(country))
      || !Array.isArray(addresses) || addresses.length === 0) {
      return
    }

    const file = DISK_CACHE_FOLDER + `/${country}.ip${ip6?6:4}`;
    await writeFileAsync(file, addresses.join('\n') + '\n');
  }

  async checkActivationStatus(category) {
    const v4Active = await Ipset.isReferenced(this.getIPSetName(category))
    const v6Active = await Ipset.isReferenced(this.getIPSetNameForIPV6(category))

    return v4Active || v6Active
  }

  async recycleIPSet(category, deactivate = true) {
    if (deactivate) {
      // remove inactive ipset as it might occupies a lot mem
      const active = await this.checkActivationStatus(category);

      if (!active) {
        await this.deactivateCountry(this.getCountry(category));
        log.info(`Deactivated ${category} due to unreferenced ipsets`)
        return
      }
    }

    await this.updatePersistentIPSets(category, {useTemp: true});

    await this.addDynamicEntries(category, {useTemp: true});

    await this.swapIpset(category, true);

    log.info(`Successfully recycled ipset for category ${category}`)
  }

  async updateIP(code, ip, add = true) {
    if(!code || !ip) {
      return;
    }

    const category = this.getCategory(code)

    if(!this.isActivated(category)) {
      return
    }

    log.debug(add ? 'add' : 'remove', ip, add ? 'to' : 'from', code)

    let ipset, key;

    if (iptool.isV4Format(ip)) {
      ipset = this.getIPSetName(category)
      key = this.getDynamicIPv4Key(category)
    } else if (iptool.isV6Format(ip)) {
      ipset = this.getIPSetNameForIPV6(category)
      key = this.getDynamicIPv6Key(category)
    } else {
      log.error('Invalid IP', ip)
      return
    }

    this.batchOps.push(`${add ? 'add' : 'del'} ${ipset} ${ip}`);

    if (add) {
      const now = Math.floor(Date.now() / 1000)
      await rclient.zaddAsync(key, now, ip)
    } else
      await rclient.zremAsync(key, ip)
  }
}

module.exports = CountryUpdater
