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

const log = require('./logger.js')(__filename);

const redis = require('redis');
const rclient = redis.createClient();

const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

const async = require('asyncawait/async');
const await = require('asyncawait/await');


const util = require('util');

const firewalla = require('../net2/Firewalla.js');

const instance = null;

class DNSTool {

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

  getDNSKey(ip) {
    return util.format("dns:ip:%s", ip);
  }


  dnsExists(ip) {
    let key = this.getDnsKey(ip);

    return rclient.existsAsync(key)
      .then((exists) => {
        return exists == 1
      })
  }

  getDns(ip) {
    let key = this.getDnsKey(ip);

    return rclient.hgetallAsync(key);
  }  

  addDns(ip, dns, expire) {
    dns = dns || {}
    expire = expire || 7 * 24 * 3600; // one week by default

    let key = this.getDnsKey(ip);

    log.info("Storing dns for ip", ip);

    dns.updateTime = `${new Date() / 1000}`

    return rclient.hmsetAsync(key, dns)
      .then(() => {
        return rclient.expireAsync(key, expire);
      });
  }

  removeDns(ip) {
    let key = this.getDnsKey(ip);

    return rclient.delAsync(key);
  }

  getDNS(ip) {
    let key = this.getDNSKey(ip);

    return rclient.hgetallAsync(key);
  }
}


module.exports = DNSTool;
