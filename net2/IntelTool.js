/*    Copyright 2016 Firewalla INC
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

let log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

let bone = require('../lib/Bone.js');

let util = require('util');

let flowUtil = require('../net2/FlowUtil.js');

const firewalla = require('../net2/Firewalla.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

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
    }
    return instance;
  }

  getIntelKey(ip) {
    return util.format("intel:ip:%s", ip);
  }

  getURLIntelKey(url) {
    return util.format("intel:url:%s", url);
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

  getIntel(ip) {
    let key = this.getIntelKey(ip);

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

  async addIntel(ip, intel, expire) {
    intel = intel || {}
    expire = expire || 7 * 24 * 3600; // one week by default

    let key = this.getIntelKey(ip);

    log.debug("Storing intel for ip", ip);

    intel.updateTime = `${new Date() / 1000}`

    await rclient.hmsetAsync(key, intel);
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

    intel.updateTime = `${new Date() / 1000}`

    await rclient.hmsetAsync(key, intel);

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

  removeIntel(ip) {
    let key = this.getIntelKey(ip);

    return rclient.delAsync(key);
  }

  removeURLIntel(url) {
    return rclient.delAsync(this.getURLIntelKey(url));
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
        _alist:hashList,
        alist:urlList,
        flow:{ fd }
      });
    } else {
      list.push({
        _alist:hashList,
        flow:{ fd }
      });
    }

    let data = {flowlist:list, hashed:1};

    try {
      const result = await bone.intelAsync("*", "check", data);
      return result;
    } catch (err) {
      log.error("Failed to get intel for urls", urlList, "err:", err);
      return null;
    }
  }

  async checkIntelFromCloud(ipList, domainList, fd) {
    log.debug("Checking intel for",fd, ipList, domainList);
    if (fd == null) {
      fd = 'in';
    }

    let flowList = [];
    let _ipList = [];
    let _aList = [];
    let _hList = [];

    ipList.forEach((ip)=>{
      _ipList = _ipList.concat(flowUtil.hashHost(ip));
    });

    let hashCache = {}

    domainList.forEach((d) => {
      let hds = flowUtil.hashHost(d, {keepOriginal: true});
      hds.forEach((hash) => {
        this.updateHashMapping(hashCache, hash)
      })

      hds = hds.map((x) => x.slice(1, 3)) // remove the origin domains

      _hList = _hList.concat(hds);

      let ads = flowUtil.hashApp(d);
      _aList = _aList.concat(ads);
    });

    _ipList.push.apply(_ipList, _hList);

    if(this.debugMode) {
      flowList.push({
        iplist:ipList,
        hlist:domainList,
        alist:domainList,
        _iplist:_ipList,
        _hlist:_hList,
        _alist:_aList,
        flow:{fd:fd}});
    } else {
      flowList.push({
        _iplist:_ipList,
        _hlist:_hList,
        _alist:_aList,
        flow:{fd:fd}});
    }

    let data = {flowlist:flowList, hashed:1};

    //    log.info(require('util').inspect(data, {depth: null}));

    try {
      const results = await bone.intelAsync('*', 'check', data)
      if(Array.isArray(results)) {
        results.forEach((result) => {
          const ip = result.ip
          if(hashCache[ip]) {
            result.originIP = hashCache[ip]
          }
        })
      }
      log.debug("IntelCheck Result:",ipList, domainList, data);

      return results
    } catch(err) {
      log.error("IntelCheck Result FAIL:", ipList, data);
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
}


module.exports = IntelTool;
