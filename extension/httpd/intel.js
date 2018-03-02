const util = require('util');
const Promise = require('bluebird');
const Redis = require("redis");

const log = require("../../net2/logger")('intel');
const bone = require('../../lib/Bone');
const flowUtil = require('../../net2/FlowUtil.js');

const redis = Redis.createClient();
Promise.promisifyAll(Redis.RedisClient.prototype);

class Intel {
  constructor(types) {
    (async () => {
      this.types = await Promise.map(await redis.keysAsync('dns:hashset:*'), key => key.split(':')[2]);
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
      let result = await this.checkIntelLocally(dn);
      log.info('local intel result:', util.inspect(result, {colors: true, depth: null}));

      return await this.checkIntelFromCloud(dn);
    } catch (err) {
      log.error("Error:", err, {});
    }
  }

  async checkIntelLocally(dn) {
    const hashedDomains = flowUtil.hashHost(dn, {keepOriginal: true});
    log.info("hds:\n", util.inspect(hashedDomains, {colors: true}));

    return (await Promise.map(this.types, async type => {
      const key = `dns:hashset:${type}`;

      // hashedDomain[0]: domain name, [1]: short hash, [2]: full hash
      let results = await Promise.map(hashedDomains, async hashedDomain => ({
        dn: hashedDomain[0],
        isMember: await redis.sismemberAsync(key, hashedDomain[2])
      }));

      let result = results.reduce((acc, cur) => acc || cur.isMember, false);

      return {type, member: result.isMember};
    })).reduce((acc, cur) => Object.assign(acc, {[cur.type]: [cur.member]}), {});
  };

  async checkIntelFromCloud(dn) {
    log.info("Checking intel for", dn);
    bone.setToken(await this.jwt());
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
      results = await bone.intelAsync("*", "", "check", data);
    } catch (err) {
      log.error('Unable to get intel from cloud', err, {});
    }

    if (Array.isArray(results) && results.length > 0) {
      best = results.reduce((best, cur) => origHost[cur.ip].length > origHost[best.ip].length ? cur : best);
    }

    return best ? best.c : null;
  }
}

module.exports = new Intel();