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
  
  async jwt() {
    try {
      return await redis.getAsync("sys:bone:jwt");
    } catch (err) {
      // null
    }
  }

  async check(dn) {
    try {
      let intel = await this.checkIntelLocally(dn);
      log.info(`local intel for ${dn} is: ${intel}`);

      if (intel) {
        return intel;
      }

      intel = await this.checkIntelFromCloud(dn);
      log.info(`cloud intel for ${dn} is: ${intel}`);

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

  async checkIntelFromCloud(dn) {
    log.info("Checking intel for", dn);
    //log.debug(`JWT: ${bone.getToken()}`);

    let origHost = {};
    let debugMode = false;

    let hds = flowUtil.hashHost(dn, {keepOriginal: true});
    hds.forEach(hd => origHost[hd[2]] = hd[0]);

    let _hlist = hds.map(x => x.slice(1, 3));
    let _alist = flowUtil.hashApp(dn);

    //log.debug('Mapping: ' + util.inspect(origHost));

    let alist = [dn], hlist = [dn], iplist = [dn];
    let _iplist = _hlist;
    let flow = {fd: 'in'};

    let flowlist = debugMode ?
      [{iplist, hlist, alist, _iplist, _hlist, _alist, flow}] :
      [{_iplist, _hlist, _alist, flow}];

    let data = {flowlist, hashed: 1};

    //log.info(util.inspect(data, {depth: null}));

    let results, best;

    try {
      results = await this.intel("*", "", "check", data);
    } catch (err) {
      log.error('Unable to get intel from cloud', err, {});
    }

    if (Array.isArray(results) && results.length > 0) {
      best = results.reduce((best, cur) => origHost[cur.ip].length > origHost[best.ip].length ? cur : best);
    }

    return best ? best.c : null;
  }

  async intel(ip, type, action, intel) {
    log.debug("/intel/host/" + ip + "/" + action);
    let options = {
      uri: getEndpoint() + '/intel/host/' + ip + '/' + action,
      family: 4,
      method: 'POST',
      auth: {
        bearer: await this.jwt()
      },
      json: intel,
      timeout: 10000 // 10 seconds
    };

    return new Promise((resolve, reject) => {
      request(options, (err, httpResponse, body) => {
        if (err) {
          reject(err);
        } else {
          resolve(body);
        }
      });
    });
  }
}

module.exports = new Intel();