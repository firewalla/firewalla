/*    Copyright 2019-2025 Firewalla Inc.
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
const country = require('../extension/country/country.js')
const ipUtil = require('../util/IPUtil.js')

const exec = require('child-process-promise').exec
const sem = require('../sensor/SensorEventManager.js').getInstance();

let instance = null

const EXPIRE_TIME = 60 * 60 * 48 // 2 days

const _ = require('lodash')

const fsp = require('fs').promises
const net = require("net");

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

  getDynamicKey(category, ip6 = false) {
    return `dynamicCategory:${category}:ip${ip6?6:4}:net`
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
    for (let ip6 of [false, true]) try {
      const key = this.getDynamicKey(category, ip6)

      const ipsetName = this.getIPSetName(category, false, ip6, options.useTemp)
      const entries = await rclient.zrangeAsync(key, 0, -1)

      // individual IPs will still be adding to the set until rotated out by CIDRs in updateIP()
      await Ipset.testAndAdd(entries, ipsetName, 60)
    } catch(err) {
      log.error(`Failed adding v${ip6?6:4} dynamic entries to ${category}`, err)
    }
  }

  async updateIpset(category, ip6 = false, options) {
    const ipsetName = this.getIPSetName(category, false, ip6, options.useTemp)

    const country = this.getCountry(category);
    const file = DISK_CACHE_FOLDER + `/${country}.ip${ip6?6:4}`;

    if (options.useTemp && !ip6) try {
      const countFile = file + '.count'
      const entriesCount = Number(await fsp.readFile(countFile))
      const setMeta = await Ipset.read(ipsetName, true)
      if (entriesCount > Number(_.get(setMeta, 'header.maxelem'))) {
        await this.rebuildIpset(category, ip6, Object.assign({count: entriesCount}, options))
      }
    } catch(err) {
      log.error('Failed to rebuild temp ipset', err)
    }

    try {
      await exec(`sudo ipset flush ${ipsetName}`)
      const cmd4 = `sed 's=^=add ${ipsetName} = ' ${file} | sudo ipset restore -!`
      await exec(cmd4)
    } catch(err) {
      log.error(`Failed to update ipset by category ${category} with ipv${ip6?6:4} addresses`, err.message)
    }
  }

  async addAddresses(country, ip6 = false, addresses) {
    if (!country || !this.isActivated(this.getCategory(country))
      || !Array.isArray(addresses) || addresses.length === 0) {
      return
    }

    const file = DISK_CACHE_FOLDER + `/${country}.ip${ip6?6:4}`;
    await fsp.writeFile(file, addresses.join('\n') + '\n');
    const countFile = file + '.count'
    await fsp.writeFile(countFile, addresses.length);
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

    // only update v4 persistent set, v6 space is too big for this approach
    await this.updatePersistentIPSets(category, false, {useTemp: true});

    await this.addDynamicEntries(category, {useTemp: true});

    await this.swapIpset(category, true);

    log.info(`Successfully recycled ipset for category ${category}`)
  }

  async updateIP(ip, code, add = true) {
    if (!ip || ip == 'undefined') {
      return
    }
    const fam = net.isIP(ip)
    if (fam == 0) {
      throw new Error(`updateIP: invalid input: ${JSON.stringify(ip)} / ${code}`)
    }

    let CIDRs = [ ip ]
    const geoip = country.geoip.lookup(ip)
    if (geoip && (!code || geoip.country == code)) {
      code = geoip.country
      CIDRs = ipUtil.numberToCIDRs(geoip.range[0], geoip.range[1], fam)
    }
    if (!code) return
    log.debug('updateIP', ip, code, CIDRs)

    const category = this.getCategory(code)

    if(!this.isActivated(category)) {
      return
    }

    log.debug(add ? 'add' : 'remove', ip, add ? 'to' : 'from', code)

    let ipset, key;

    if (fam == 4) {
      ipset = this.getIPSetName(category)
      key = this.getDynamicIPv4Key(category)
    } else if (fam == 6) {
      ipset = this.getIPSetNameForIPV6(category)
      key = this.getDynamicIPv6Key(category)
    }

    if (add) {
      const now = Math.floor(Date.now() / 1000)
      await rclient.zaddAsync(key, _.flatMap(CIDRs, v=> [now, v]))

      // test and add ipset right away to enforce policies
      await Ipset.testAndAdd(CIDRs, ipset)
    } else
      await rclient.zremAsync(key, ip)

      this.batchOps.push(`del ${ipset} ${ip}`);
  }
}

module.exports = CountryUpdater
