const util = require('util');
const Promise = require('bluebird');
const Redis = require("redis");
const request = require('request');

const log = require("../../net2/logger")('intel');
const flowUtil = require('../../net2/FlowUtil.js');

const redis = Redis.createClient();
Promise.promisifyAll(Redis.RedisClient.prototype);

class Intel {
  constructor() {
    (async () => {
      this.types = (await Promise.map(await redis.keysAsync('dns:hashset:*'), key => key.split(':')[2])).filter(x => x);
    })();
  }

  async check(dn) {
    try {
      let intel = await this.checkIntelLocally(dn);
      log.info(`local intel for ${dn} is: ${intel}`);
      return intel;
    } catch (err) {
      log.error("Error when check intel:", err, {});
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
            isMember: await redis.sismemberAsync(`dns:hashset:${type}`, hdn[2])
          })))
          .reduce((acc, cur) => acc || cur.isMember, false)
      })))
      .reduce((acc, cur) => Object.assign(acc, {[cur.type]: cur.isMember}), {});
  };

}

module.exports = new Intel();