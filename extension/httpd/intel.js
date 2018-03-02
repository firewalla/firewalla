const util = require('util');
const Promise = require('bluebird');
const Redis = require("Redis");

const log = require("../../net2/logger")('intel');
const bone = require('../../lib/Bone');
const flowUtil = require('../../net2/FlowUtil.js');

const redis = Redis.createClient();
Promise.promisifyAll(Redis.RedisClient.prototype);

class Intel {
  
  constructor(types) {
    this.types = types;
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
      log.info('local intel result:', util.inspect(result));


      return await this.checkIntelFromCloud(dn);
    } catch (err) {
      log.error("Error:", err, {});
    }
  }
  
  async checkIntelLocally(dn) {
    return Promise.map(types, async type => {
      let key = `dns:hashset:${type}`;

      let hds = flowUtil.hashHost(dn);

      return Promise.map(hds, async hd => ({type, isMember: await redis.sismemberAsync(key, hd)}));
    });
  }

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