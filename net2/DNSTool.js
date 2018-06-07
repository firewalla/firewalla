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

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird');

const f = require('../net2/Firewalla.js')

const iptool = require('ip')

const util = require('util');

const firewalla = require('../net2/Firewalla.js');

const RED_HOLE_IP="198.51.100.101";

let instance = null;

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

  getReverseDNSKey(dns) {
    return `rdns:domain:${dns}`
  }

  async reverseDNSKeyExists(domain) {
    const type = await rclient.typeAsync(this.getReverseDNSKey(domain))
    return type !== 'none';
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

    dns.updateTime = `${new Date() / 1000}`

    return rclient.hmsetAsync(key, dns)
      .then(() => {
        return rclient.expireAsync(key, expire);
      });
  }

  // doesn't have to keep it long, it's only used for instant blocking

  async addReverseDns(dns, addresses, expire) {
    expire = expire || 24 * 3600; // one day by default
    addresses = addresses || []

    addresses = addresses.filter((addr) => {
      return f.isReservedBlockingIP(addr) != true
    })

    let key = this.getReverseDNSKey(dns)

    const existing = await this.reverseDNSKeyExists(dns)
    
    let updated = false

    for (let i = 0; i < addresses.length; i++) {  
      const addr = addresses[i];

      if(iptool.isV4Format(addr) || iptool.isV6Format(addr)) {
        await rclient.zaddAsync(key, new Date() / 1000, addr)
        updated = true
      }
    }
    
    if(updated === false && existing === false) {
      await rclient.zaddAsync(key, new Date() / 1000, RED_HOLE_IP); // red hole is a placeholder ip for non-existing domain 
    }

    await rclient.expireAsync(key, expire)
  }

  async getAddressesByDNS(dns) {
    let key = this.getReverseDNSKey(dns)
    return rclient.zrangeAsync(key, "0", "-1")
  }

  async getAddressesByDNSPattern(dnsPattern) {
    let pattern = `rdns:domain:*.${dnsPattern}`
    
    let keys = await rclient.keysAsync(pattern)
    
    let list = []
    if(keys) {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        let l = await rclient.zrangeAsync(key, "0", "-1")
        list.push.apply(list, l)
      }
    }
    
    return list
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
