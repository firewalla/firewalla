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

const flowUtil = require('../net2/FlowUtil.js');

const firewalla = require('../net2/Firewalla.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()
const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()
const CountryUpdater = require('../control/CountryUpdater.js')
const countryUpdater = new CountryUpdater()

const country = require('../extension/country/country.js');

const _ = require('lodash')

const DEFAULT_INTEL_EXPIRE = 2 * 24 * 3600; // two days

const TRUST_THRESHOLD = 10 // to be updated

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
      this.customIntelDomains = new Set()
      this.init()
    }
    return instance;
  }

  async init() {
    try {
      const customDomainListKey = this.getCustomIntelListKey('dns')
      // smembers always return array so this is fine
      for (const domain of await rclient.smembersAsync(customDomainListKey))
        this.customIntelDomains.add(domain)

      sclient.subscribe('list:intel:custom:updated')
      sclient.on('message', (channel, message) => {
        if (channel == 'list:intel:custom:updated') {
          const { action, type, target } = JSON.parse(message)
          if (type == 'dns') {
            log.debug('list:intel:custom:updated', action, type, target)
            if (action == 'add')
              this.customIntelDomains.add(target)
            else
              this.customIntelDomains.delete(target)
          }
        }
      })
    } catch(err) {
      log.error('Error initializing', err)
    }
  }

  getUnblockKey(ip) {
    return util.format("auto:unblock:%s", ip);
  }

  getIpIntelKey(ip) {
    return util.format("intel:ip:%s", ip);
  }

  getURLIntelKey(url) {
    return util.format("intel:url:%s", url);
  }

  getDomainIntelKey(domain) {
    return `inteldns:${domain}`;
  }

  getCustomIntelListKey(type) {
    return `list:intel:custom:${type}`
  }

  async getDomainIntel(domain) {
    const key = this.getDomainIntelKey(domain);
    return rclient.hgetallAsync(key);
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

  findCustomIntelDomain(domain) {
    const subDomains = flowUtil.getSubDomains(domain) || [];
    return subDomains.find(d => this.customIntelDomains.has(d))
  }

  // TODO: use shorter key name in redis and change it back here
  // e.g. c for category, lat for latitude
  formatIntel(intel) {
    for (const key in intel) {
      if (intel[key] == 'none')
        delete intel[key]
      switch(key) {
        case 'e':
          intel.e = Number(intel.e)
          break;
        case 'custom':
          intel.custom = JSON.parse(intel.custom)
          break;
      }
    }
    return intel
  }

  // Works with or without domains
  async getIntel(ip, domains) {
    const intel = {};

    if (ip) {
      const ipIntel = await this.getIpIntel(ip)

      if (ipIntel) {
        // no domains info in the query, return right away
        if (!_.isArray(domains) || !domains.length) {
          return this.formatIntel(ipIntel)
        }

        // domain in query matches with ip intel
        const matchedHost = ipIntel.host && domains.find(d => d.endsWith(intel.host))
        const customizedDomain = this.findCustomIntelDomain(intel.host)
        if (matchedHost && !customizedDomain) {
          ipIntel.host = matchedHost
          return this.formatIntel(ipIntel)
        }

        // none of the above, save ip intel for further aggregation
        if (ipIntel.custom) {
          // custom provided intel, keep all
          Object.assign(intel, ipIntel)
        } else {
          Object.assign(intel, _.pick(ipIntel, ['country', 'longitude', 'latitude']))
        }
      }
    }

    // no ip intel found and no domain supplied
    if (!_.isArray(domains) || !domains.length)
      return null

    intel.host = domains[0]
    const domainIntels = await this.getDomainIntelAll(intel.host);
    if (_.isArray(domainIntels) && domainIntels.length) {
      for (const domainIntel of domainIntels) {
        if (domainIntel.custom) {
          intel.custom = true
        }
        if (domainIntel.c && (!intel.category || domainIntel.custom)) {
          intel.category = domainIntel.c;
        }
        if (domainIntel.app && (!intel.app || domainIntel.custom)) {
          // no JSON parsing required here. there was a bug not properly dealing with app
          // array from the cloud, and app is saved as string
          // furthermore, intel:ip only saves the first element of app, should keep it consistent
          intel.app = domainIntel.app
        }
      }
    }

    return this.formatIntel(intel)
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

  async addDomainIntel(domain, intel, expire, flush) {
    await this.updateIntel('dns', domain, intel, expire, flush)
  }

  async urlIntelExists(url) {
    const key = this.getURLIntelKey(url);
    const exists = await rclient.existsAsync(key);
    return exists == 1;
  }

  async intelExists(ip) {
    let key = this.getIpIntelKey(ip);
    let exists = await rclient.existsAsync(key);
    return exists == 1;
  }

  async appExists(ip) {
    let key = this.getIpIntelKey(ip);
    let result = await rclient.hgetAsync(key, "app");
    return result != null;
  }

  async unblockExists(ip) {
    const key = this.getUnblockKey(ip);
    const result = await rclient.existsAsync(key);
    return result == 1;
  }

  getIpIntel(ip) {
    let key = this.getIpIntelKey(ip);

    return rclient.hgetallAsync(key);
  }

  getURLIntel(url) {
    const key = this.getURLIntelKey(url);
    return rclient.hgetallAsync(key);
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

  async addIntel(ip, intel, expire, flush) {
    await this.updateIntel('ip', ip, intel, expire, flush)
  }

  redisfy(intel) {
    const copy = JSON.parse(JSON.stringify(intel))
    if (copy.app && Array.isArray(copy.app))
      copy.app = copy.app[0]
    return copy
  }

  async updateIntel(type, target, intel, expire, flush = true) {
    log.debug('updateIntel', type, target, intel, expire, flush)
    if (!target) throw new Error('Invalid target')

    intel = intel || {}

    let key;
    switch(type) {
      case 'ip':
        key = this.getIpIntelKey(target)
        break;
      case 'url':
        key = this.getURLIntelKey(target)
        break;
      case 'dns':
        key = this.getDomainIntelKey(target)
        break;
      default:
        throw new Error(type, 'intel not supported')
    }

    log.debug("Storing intel for", target);

    intel.updateTime = `${new Date() / 1000}`

    if (flush || intel.custom === false)
      await rclient.unlinkAsync(key);

    if (intel.custom !== false) {
      await rclient.hmsetAsync(key, this.redisfy(intel));

      // inte.e has the highest priority
      expire = _.isNumber(intel.e) ? intel.e :
        _.isNumber(expire) ? expire : DEFAULT_INTEL_EXPIRE

      if (expire !== 0)
        await rclient.expireAsync(key, expire);
      else if (!flush)
        await rclient.persistAsync(key)
    }

    if (intel.custom) {
      log.debug('adding custom intel to list', target)
      await rclient.saddAsync(this.getCustomIntelListKey(type), target)
      pclient.publish('list:intel:custom:updated', JSON.stringify({ action: 'add', type, target }))
    } else if (intel.custom === false) {
      log.debug('removing custom intel from list', target)
      await rclient.sremAsync(this.getCustomIntelListKey(type), target)
      pclient.publish('list:intel:custom:updated', JSON.stringify({ action: 'del', type, target }))
    }

    switch(type) {
      case 'ip':
      case 'url':
        if(intel.category === 'intel' && intel.custom !== false) {
          await this.updateSecurityIntelTracking(key);
        } else {
          await this.removeFromSecurityIntelTracking(key);
        }
        break;
      case 'dns':
        // TODO: revalidate inteldns here as well?
        break;
      default:
        throw new Error(type, 'intel not supported')
    }
  }

  async addURLIntel(url, intel, expire, flush) {
    await this.updateIntel('url', url, intel, expire, flush)
  }

  async updateExpire(ip, expire) {
    expire = expire || 7 * 24 * 3600; // one week by default

    const key = this.getIpIntelKey(ip);
    return rclient.expireAsync(key, expire);
  }

  async setUnblockExpire(ip, expire) {
    expire = expire || 6 * 3600;
    const key = this.getUnblockKey(ip);
    await rclient.setAsync(key, "default");
    return rclient.expireAsync(key, expire);
  }

  removeIntel(ip) {
    let key = this.getIpIntelKey(ip);

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

    log.debug("Checking intel for", fd, ip, domain);
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
    const intel = await this.getIpIntel(ip)
    return intel && intel.country || country.getCountry(ip);
  }

  async updateCategoryDomain(intel) {
    if (intel.host && intel.category && (intel.t > TRUST_THRESHOLD || intel.custom)) {
      if (intel.originIP) {
        await categoryUpdater.updateDomain(intel.category, intel.originIP, intel.isOriginIPAPattern)
      } else {
        await categoryUpdater.updateDomain(intel.category, intel.host)
      }
    }
  }

  async updateCountryIP(intel) {
    if (intel.ip && intel.country) {
      await countryUpdater.updateIP(intel.country, intel.ip)
    }
  }
}


module.exports = IntelTool;
