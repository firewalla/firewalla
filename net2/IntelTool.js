/*    Copyright 2016-2022 Firewalla Inc.
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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const bone = require('../lib/Bone.js');

const util = require('util');
const { mapLimit } = require('../util/asyncNative.js')

const flowUtil = require('../net2/FlowUtil.js');

const firewalla = require('../net2/Firewalla.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const country = require('../extension/country/country.js');

const _ = require('lodash')

const DEFAULT_INTEL_EXPIRE = 2 * 24 * 3600; // two days

let instance = null;

class IntelTool {

  constructor() {
    if(!instance) {
      instance = this;
      if(firewalla.isProduction()) {
        this.debugMode = false;
      } else {
        this.debugMode = true;
      }

      // There should not be many of those, read all into memory to speed up intel fetching
      this.listMap = {
        'ip': new Set(),
        'dns': new Set(),
      }
      this.init()
    }
    return instance;
  }

  async init() {
    for (const type of ['ip', 'dns']) try {
      const customIntelListKey = this.getCustomIntelListKey(type)
      // smembers always return array so this is fine
      for (const entry of await rclient.smembersAsync(customIntelListKey))
        this.listMap[type].add(entry)

      sclient.subscribe('list:intel:custom:updated')
      sclient.on('message', (channel, message) => {
        if (channel == 'list:intel:custom:updated') {
          const { action, type, target } = JSON.parse(message)
          log.debug('list:intel:custom:updated', action, type, target)
          if (action == 'add')
            this.listMap[type].add(target)
          else
            this.listMap[type].delete(target)
        }
      })
    } catch(err) {
      log.error('Error initializing custom', type, err)
    }
  }

  getUnblockKey(ip) {
    return util.format("auto:unblock:%s", ip);
  }

  getIntelKey(ip) {
    return util.format("intel:ip:%s", ip);
  }

  getURLIntelKey(url) {
    return util.format("intel:url:%s", url);
  }

  getDomainIntelKey(domain) {
    return `inteldns:${domain}`;
  }

  getCustomIntelKey(type, target) {
    return `intel:custom:${type}:${target}`
  }

  getCustomIntelListKey(type) {
    return `list:intel:custom:${type}`
  }

  redisfy(type, intel) {
    const copy = JSON.parse(JSON.stringify(intel))

    switch (type) {
      case 'ip':
        delete copy.ip
        break;
      case 'url':
        delete copy.url
        break;
      case 'dns':
        if (intel.category) {
          copy.c = intel.category
          delete copy.category
        }
        delete copy.originIP // stores domain name, which is already in key
        break;
      default:
        throw new Error('Type not supported:', type)
    }

    if (copy.app) {
      if (_.isString(copy.app)) {
        if (copy.app.startsWith('{')) try {
          const apps = Object.keys(JSON.parse(copy.app))
          copy.app = apps[0]
        } catch(err) {
          log.error('Error parsing intel.app', copy)
        }
      } else {
        const apps = Object.keys(copy.app)
        copy.app = apps[0]
      }
    }

    copy.updateTime = Date.now() / 1000

    return copy
  }

  format(type, target, intel) {
    if (!intel || !target || !intel) return null

    switch (type) {
      case 'ip':
        intel.ip = target
        break;
      case 'url':
        intel.url = target
        break;
      case 'dns':
        if (intel.c) {
          intel.category = intel.c
          delete intel.c
        }
        intel.originIP = target
        break;
      default:
        throw new Error('Type not supported:', type)
    }

    return intel
  }

  async listCustomIntel(type) {
    const result = {}
    for (const t in this.listMap) {
      if (type && t != type) continue
      result[t] = await mapLimit(
        Array.from(this.listMap[t]),
        20,
        target => this.getCustomIntel(t, target)
      )
    }
    return result
  }

  async updateCustomIntel(type, target, intel, add = true) {
    const key = this.getCustomIntelKey(type, target)
    const listKey = this.getCustomIntelListKey(type)

    if (add) {
      const redisObj = this.redisfy(type, intel)
      await rclient.hmsetAsync(key, redisObj)
      await rclient.saddAsync(listKey, target)
      pclient.publish('list:intel:custom:updated', JSON.stringify({ action: 'add', type, target }))
    } else {
      await rclient.delAsync(key)
      await rclient.sremAsync(listKey, target)
      pclient.publish('list:intel:custom:updated', JSON.stringify({ action: 'del', type, target }))
    }
  }

  async getCustomIntel(type, target) {
    if (this.listMap[type].has(target)) {
      const key = this.getCustomIntelKey(type, target)
      const intel = await rclient.hgetallAsync(key)
      return this.format(type, target, intel)
    } else {
      return null
    }
  }

  applyCustomIntel(origin, custom) {
    for (const key in custom) {
      switch (key) {
        case 'updateTime':
          continue
        default:
          if (custom[key].startsWith('not_')) {
            const excludeItem = custom[key].substring(4)
            if (origin[key] == excludeItem)
              delete origin[key]
          } else {
            origin[key] = custom[key]
          }
      }
    }

    return origin
  }

  async enforceCustomIntel(intel) {
    if (!intel) return

    if (intel.host) {
      const domains = flowUtil.getSubDomains(intel.host) || [];
      // domains ordered from sub to parent
      const customDomainIntels = await Promise.all(domains.map(d => this.getCustomIntel('dns', d)))

      // more match on domain name meaning higher priority
      for (const customDomainIntel of customDomainIntels.filter(Boolean).reverse()) {
        intel = this.applyCustomIntel(intel, customDomainIntel)
      }
    }

    if (intel.ip) {
      const customIpIntel = await this.getCustomIntel('ip', intel.ip)
      intel = this.applyCustomIntel(intel, customIpIntel)
    }

    return intel
  }

  async getDomainIntel(domain) {
    const key = this.getDomainIntelKey(domain);
    const redisObj = await rclient.hgetallAsync(key);
    return this.format('dns', domain, redisObj)
  }

  async getDomainIntelAll(domain) {
    const result = [];
    const domains = flowUtil.getSubDomains(domain) || [];
    for (const d of domains) {
      const domainIntel = await this.getDomainIntel(d);
      if (domainIntel) result.push(domainIntel)
    }
    return result;
  }

// example
// {
//   v: '1',
//   t: '50',
//   cc: '[]',
//   c: 'av',
//   s: '0',
//   ts: '1618825641',
//   r: '1',
//   app: '{"youtube":1}',
//   hash: 'LvOZqM9U3cK9V1r05/4lr38ecDvgztKSGdyzL4bvE8c=',
//   flowid: '0',
//   originIP: 'youtube.com'
  // }

  async addDomainIntel(domain, intel, expire) {
    intel = intel || {}
    expire = expire || 48 * 3600;

    const key = this.getDomainIntelKey(domain);

    log.debug("Storing intel for domain", domain);

    await rclient.hmsetAsync(key, this.redisfy('dns', intel));
    return rclient.expireAsync(key, expire);
  }

  async urlIntelExists(url) {
    const key = this.getURLIntelKey(url);
    const exists = await rclient.existsAsync(key);
    return exists == 1;
  }

  async intelExists(ip) {
    let key = this.getIntelKey(ip);
    let exists = await rclient.existsAsync(key);
    return exists == 1;
  }

  async appExists(ip) {
    let key = this.getIntelKey(ip);
    let result = await rclient.hgetAsync(key, "app");
    return result != null;
  }

  async unblockExists(ip) {
    const key = this.getUnblockKey(ip);
    const result = await rclient.existsAsync(key);
    return result == 1;
  }

  async getIntel(ip, domains = [], withCutomIntel = true) {
    let intel = null

    if (ip) {
      const key = this.getIntelKey(ip);
      const redisObj = await rclient.hgetallAsync(key);
      intel = this.format('ip', ip, redisObj)
    }

    if (_.isArray(domains) && domains.length) {
      let matchedHost = null
      if (intel) {
        // domain in query matches with ip intel
        matchedHost = intel.host && domains.find(d => d.endsWith(intel.host))
        if (matchedHost) {
          intel.host = matchedHost
        }
      } else {
        intel = {}
      }
      if (!matchedHost) {
        intel.host = domains[0]
        const domainIntels = await this.getDomainIntelAll(intel.host);
        for (const domainIntel of domainIntels) {
          if (domainIntel.category && !intel.category) {
            intel.category = domainIntel.category;
          }
          if (domainIntel.app && !intel.app) {
            // no JSON parsing required here. there was a bug not properly dealing with app
            // array from the cloud, and app is saved as string
            // furthermore, intel:ip only saves the first element of app, should keep it consistent
            intel.app = domainIntel.app
          }
        }
      }
    }

    // custome intel got enforced as highest priority
    if (withCutomIntel)
      await this.enforceCustomIntel(intel)

    return intel
  }

  async getURLIntel(url) {
    const key = this.getURLIntelKey(url);
    const redisObj = await rclient.hgetallAsync(key);
    return this.format('url', url, redisObj)
  }

  getSecurityIntelTrackingKey() {
    return "intel:security:tracking"
  }

  async securityIntelTrackingExists() {
    const exists = await rclient.existsAsync(this.getSecurityIntelTrackingKey());
    return exists === 1;
  }

  async updateSecurityIntelTracking(intelKey) {
    return rclient.zaddAsync(this.getSecurityIntelTrackingKey(), new Date() / 1000, intelKey);
  }

  async removeFromSecurityIntelTracking(intelKey) {
    return rclient.zremAsync(this.getSecurityIntelTrackingKey(), intelKey);
  }

  async addIntel(ip, intel, expire) {
    intel = intel || {}
    expire = intel.e || DEFAULT_INTEL_EXPIRE

    let key = this.getIntelKey(ip);

    log.debug("Storing intel for ip", ip);

    intel.updateTime = `${new Date() / 1000}`

    await rclient.hmsetAsync(key, this.redisfy('ip', intel));
    if(intel.host && intel.ip) {
      // sync reverse dns info when adding intel
      await dnsTool.addReverseDns(intel.host, [intel.ip])
    }

    if(intel.category === 'intel') {
      await this.updateSecurityIntelTracking(key);
    } else {
      await this.removeFromSecurityIntelTracking(key);
    }
    return rclient.expireAsync(key, expire);
  }

  async addURLIntel(url, intel, expire) {
    intel = intel || {}
    expire = expire || 7 * 24 * 3600; // one week by default

    let key = this.getURLIntelKey(url);

    log.debug("Storing intel for url", url);

    await rclient.hmsetAsync(key, this.redisfy('url', intel));

    if(intel.category === 'intel') {
      await this.updateSecurityIntelTracking(key);
    } else {
      await this.removeFromSecurityIntelTracking(key);
    }
    return rclient.expireAsync(key, expire);
  }

  async updateExpire(ip, expire) {
    expire = expire || 7 * 24 * 3600; // one week by default

    const key = this.getIntelKey(ip);
    return rclient.expireAsync(key, expire);
  }

  async setUnblockExpire(ip, expire) {
    expire = expire || 6 * 3600;
    const key = this.getUnblockKey(ip);
    await rclient.setAsync(key, "default");
    return rclient.expireAsync(key, expire);
  }

  removeIntel(ip) {
    let key = this.getIntelKey(ip);

    return rclient.unlinkAsync(key);
  }

  removeURLIntel(url) {
    return rclient.unlinkAsync(this.getURLIntelKey(url));
  }

  updateHashMapping(hashCache, hash) {
    if(Array.isArray(hash)) {
      const origin = hash[0]
      const hashedOrigin = hash[2]
      hashCache[hashedOrigin] = origin
    }
  }

  async checkURLIntelFromCloud(urlList, fd) {
    fd = fd || 'in';

    log.info("Checking Intel for urls:", urlList);

    let list = [];

    const hashList = urlList.map((item) => item.slice(1, 3));

    if (this.debugMode) {
      list.push({
        _alist: hashList,
        alist: urlList.map(item => item[0]),
        flow: { fd }
      });
    } else {
      list.push({
        _alist: hashList,
        flow: { fd }
      });
    }

    let data = { flowlist: list, hashed: 1 };

    try {
      const result = await bone.intelAsync("*", "check", data);
      return result;
    } catch (err) {
      log.error("Failed to get intel for urls", urlList, "err:", err);
      return null;
    }
  }

  async checkIntelFromCloud(ip, domain, options = {}) {
    let {fd, lucky} = options;

    log.debug("Checking intel for", ip, domain, ', dir:', fd);
    if (fd == null) {
      fd = 'in';
    }

    const _ipList = flowUtil.hashHost(ip, { keepOriginal: true }) || [];

    const hashCache = {}

    const hds = flowUtil.hashHost(domain, { keepOriginal: true }) || [];
    _ipList.push.apply(_ipList, hds);

    _ipList.forEach((hash) => {
      this.updateHashMapping(hashCache, hash)
    })

    const _ips = _ipList.map((x) => x.slice(1, 3)); // remove the origin domains
    const _hList = hds.map((x) => x.slice(1, 3));

    const _aList = flowUtil.hashApp(domain);

    const flowList = [{
      _iplist: _ips,
      _hlist: _hList,
      _alist: _aList,
      flow: { fd }
    }]

    if (this.debugMode) {
      Object.assign(flowList[0], {
        iplist: [ip],
        hlist: [domain],
        alist: [domain]
      })
    }

    const data = { flowlist: flowList, hashed: 1 };
    if(lucky) {
      data.lucky = 1;
    }
    log.debug(require('util').inspect(data, { depth: null }));

    try {
      const results = await bone.intelAsync('*', 'check', data)
      if (Array.isArray(results)) {
        results.forEach((result) => {
          const ip = result.hash
          if (hashCache[ip]) {
            result.originIP = hashCache[ip]
          }
        })
      }
      log.debug("IntelCheck Result:", ip, domain, results);

      return results
    } catch (err) {
      log.error("IntelCheck Result FAIL:", ip, data, err);
      throw err;
    }
  }

  getUserAgentKey(src, dst, dstPort) {
    dstPort = dstPort || 80;
    return util.format("user_agent:%s:%s:%s", src, dst, dstPort);
  }

  async getUserAgent(src, dst, dstPort) {
    let key = this.getUserAgentKey(src, dst, dstPort);
    const userAgent = await rclient.getAsync(key);
    if (userAgent) {
      return userAgent;
    } else {
      return undefined;
    }
  }

  getSSLCertKey(ip) {
    return util.format("host:ext.x509:%s", ip);
  }

  async getSSLCertificate(ip) {
    let certKey = this.getSSLCertKey(ip);

    let sslInfo = await rclient.hgetallAsync(certKey);
    if (sslInfo) {
      let subject = sslInfo.subject;
      if (subject) {
        let result = this._parseX509Subject(subject);
        if (result) {
          sslInfo.CN = result.CN || ""
          sslInfo.OU = result.OU || ""
          sslInfo.O = result.O || ""
        }
      }

      return sslInfo;
    } else {
      return undefined;
    }

  }

  updateSSLExpire(ip, expire) {
    expire = expire || 7 * 24 * 3600; // one week by default

    const key = this.getSSLCertKey(ip);
    return rclient.expireAsync(key, expire);
  }

  _parseX509Subject(subject) {
    let array = subject.split(',');
    let result = {};
    for (let i in array) {
      let obj = array[i].split("=");
      if (obj.length == 2) {
        result[obj[0]] = obj[1];
      }
    }

    return result;
  }

  async updateDNSExpire(ip, expire) {
    expire = expire || 7 * 24 * 3600; // one week by default

    const key = dnsTool.getDNSKey(ip);
    return rclient.expireAsync(key, expire);
  }

  async getDNS(ip) {
    return dnsTool.getDns(ip);
  }

  async getCountry(ip) {
    const intel = await this.getIntel(ip)
    return intel && intel.country || country.getCountry(ip);
  }
}


module.exports = IntelTool;
