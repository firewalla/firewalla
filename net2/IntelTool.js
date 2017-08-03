/*    Copyright 2016 Firewalla LLC
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

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let async2 = require('async');

let bone = require('../lib/Bone.js');

let util = require('util');

let flowUtil = require('../net2/FlowUtil.js');

let firewalla = require('../net2/Firewalla.js');

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


  intelExists(ip) {
    let key = this.getIntelKey(ip);

    return rclient.keysAsync(key)
      .then((keys) => {
        if(keys.length === 1) {
          return true;
        } else {
          return false;
        }
      })
  }

  getIntel(ip) {
    let key = this.getIntelKey(ip);

    return rclient.hgetallAsync(key);
  }

  addIntel(ip, intel, expire) {
    expire = expire || 7 * 24 * 3600; // one week by default

    let key = this.getIntelKey(ip);

    log.info("Storing intel for ip", ip);

    return rclient.hmsetAsync(key, intel)
      .then(() => {
        return rclient.expireAsync(key, expire);
      });
  }

  removeIntel(ip) {
    let key = this.getIntelKey(ip);

    return rclient.delAsync(key);
  }

  checkIntelFromCloud(ipList, domainList) {
    log.info("Checking intel for", ipList, domainList, {});
    
    let flowList = [];
    let _ipList = [];

    if(this.debugMode) {
      _ipList.push.apply(_ipList, ipList);
      _ipList.push.apply(_ipList, domainList);
      flowList.push({
        iplist:_ipList,
        _iplist:_ipList
      })
    } else {
      _ipList.push.apply(_ipList,
        ipList.map((i) => flowUtil.hashIp(i)));

      domainList.forEach((d) => {
        let hds = flowUtil.hashHost(d);
        _ipList.push.apply(_ipList, hds);
      });

      flowList.push({
        _iplist:_ipList,
        flow: {fd: 'in'}      // this line is just a WORKAROUND for fishbone bug. FIXME
      })
    }

    let hashed = this.debugMode ? 0 : 1;

    let data = {flowlist:flowList, hashed:hashed};

    // log.info(require('util').inspect(data, {depth: null}));

    return new Promise((resolve, reject) => {
      bone.intel("*","check", data, (err, data) => {
        if(err)
          reject(err)
        else {
          log.info("IntelCheck Result:", data, {});
          resolve(data);
        }

      });
    });
  }


  getSSLCertKey(ip) {
    return util.format("host:ext.x509:%s", ip);
  }

  getSSLCertificate(ip) {
    let certKey = this.getSSLCertKey(ip);

    return async(() => {
      let sslInfo = await (rclient.hgetallAsync(certKey));
      if(sslInfo) {
        let subject = sslInfo.subject;
        if(subject) {
          let result = this._parseX509Subject(subject);
          if(result) {
            sslInfo.CN = result.CN;
            sslInfo.OU = result.OU;
          }
        }

        return sslInfo;
      } else {
        return undefined;
      }

    })();
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

  getDNSKey(ip) {
    return util.format("dns:ip:%s", ip);
  }

  getDNS(ip) {
    let key = this.getDNSKey(ip);

    return rclient.hgetallAsync(key);
  }

  updateIntelKeyInDNS(ip, intel, expireTime) {
    expireTime = expireTime || 24 * 3600; // default one day

    let key = this.getDNSKey(ip);

    let intelJSON = JSON.stringify(intel);

    return rclient.hsetAsync(key, "_intel", intelJSON)
      .then(() => {
        return rclient.expireAsync(key, expireTime)
      });
  }
}


module.exports = IntelTool;
