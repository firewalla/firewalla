/*    Copyright 2019-2022 Firewalla Inc.
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

const Promise = require('bluebird');

const log = require("../../net2/logger")('intel');
const flowUtil = require('../../net2/FlowUtil.js');

class Intel {
  constructor(redis) {
    this.redis = redis;
    (async () => {
      this.types = (await Promise.map(await this.redis.scanResults('dns:hashset:*'), key => key.split(':')[2])).filter(x => x);
    })();
  }

  async check(dn) {
    try {
      let intel = await this.checkIntelLocally(dn);
      log.info(`local intel for ${dn} is: ${intel}`);
      return intel;
    } catch (err) {
      log.error("Error when check intel:", err);
    }
  }

  async checkIntelLocally(dn) {
    let inList = await this.matchHashedDomainsInRedis(dn);

    if (inList.family) {
      return 'porn'
    } else if (inList.adblock) {
      return 'ad';
    }
  }

  async matchHashedDomainsInRedis(dn) {
    const hashedDomains = flowUtil.hashHost(dn, {keepOriginal: true});
    //log.debug("hds:\n", util.inspect(hashedDomains, {colors: true}));

    return (await Promise.map(this.types,
      async type => ({
        type,
        isMember: (await Promise.map(hashedDomains,
          async hdn => ({ // hdn[0]: domain name, hdn[1]: short hash, hdn[2]: full hash
            isMember: await this.redis.sismemberAsync(`dns:hashset:${type}`, hdn[2])
          })))
          .reduce((acc, cur) => acc || cur.isMember, false)
      })))
      .reduce((acc, cur) => Object.assign(acc, {[cur.type]: cur.isMember}), {});
  };
}

module.exports = redis => new Intel(redis);
