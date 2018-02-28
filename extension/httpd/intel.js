const util = require('util');
const Promise = require('bluebird');
const redis = require("redis");

const log = require("../../net2/logger")('intel');
const bone = require('../../lib/Bone');
const flowUtil = require('../../net2/FlowUtil.js');

const rclient = redis.createClient();
Promise.promisifyAll(redis.RedisClient.prototype);

class Intel {
  async jwt() {
    try {
      return await rclient.getAsync("sys:bone:jwt");
    } catch (err) {
      // null
    }
  }

  async check(dn) {
    try {
      return await this.checkIntelFromCloud(dn);
    } catch (err) {
      log.error("Error:", err, {});
    }
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