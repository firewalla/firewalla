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

const iptool = require('ip')

const util = require('util');

const firewalla = require('../net2/Firewalla.js');

let instance = null;
const DomainUpdater = require('../control/DomainUpdater.js');
const domainUpdater = new DomainUpdater();

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

  getReverseDNSKey(domainName) {
    return `rdns:domain:${domainName}`
  }

  async reverseDNSKeyExists(domain) {
    const type = await rclient.typeAsync(this.getReverseDNSKey(domain))
    return type !== 'none';
  }

  dnsExists(ip) {
    let key = this.getDNSKey(ip);

    return rclient.existsAsync(key)
      .then((exists) => {
        return exists == 1
      })
  }

  async getDns(ip) {
    let key = this.getDNSKey(ip);
    const keyType = await rclient.typeAsync(key);
    try {
      // FIXME: remove this type conversion code after it is released for several months
      // convert hash to zset
      // although there is a migration task in DataMigrationSensor, it may be not finished when this function is invoked
      if (keyType === "hash") {
        const oldDns = await rclient.hgetallAsync(key);
        await rclient.delAsync(key);
        if (oldDns.host)
          rclient.zaddAsync(key, oldDns.lastActive || now, oldDns.host);
      }
    } catch (err) {
      log.warn("Failed to convert " + key + " to zset.");
    }
    const domain = await rclient.zrevrangeAsync(key, 0, 1); // get domain with latest timestamp
    if (domain && domain.length != 0)
      return domain[0];
    else
      return null;
  }

  async addDns(ip, domain, expire) {
    expire = expire || 24 * 3600; // one day by default
    if (!iptool.isV4Format(ip) && !iptool.isV6Format(ip))
      return;
    if (firewalla.isReservedBlockingIP(ip))
      return;
    if (!domain)
      return;

    let key = this.getDNSKey(ip);
    const keyType = await rclient.typeAsync(key);
    const redisObj = [key];
    const now = Math.ceil(Date.now() / 1000);
    try {
      // FIXME: remove this type conversion code after it is released for several months
      // convert hash to zset
      // although there is a migration task in DataMigrationSensor, it may be not finished when this function is invoked
      if (keyType === "hash") {
        const oldDns = await rclient.hgetallAsync(key);
        await rclient.delAsync(key);
        if (oldDns.host)
          redisObj.push(oldDns.lastActive || now, oldDns.host);
      }
    } catch (err) {
      log.warn("Failed to convert " + key + " to zset.");
    }
    redisObj.push(now, domain);
    await rclient.zaddAsync(redisObj);
    await rclient.expireAsync(key, expire);
  }

  // doesn't have to keep it long, it's only used for instant blocking

  async addReverseDns(dns, addresses, expire) {
    expire = expire || 24 * 3600; // one day by default
    addresses = addresses || []

    addresses = addresses.filter((addr) => {
      return firewalla.isReservedBlockingIP(addr) != true
    })

    let key = this.getReverseDNSKey(dns)

    const existing = await this.reverseDNSKeyExists(dns)
    
    let updated = false
    const validAddresses = [];

    for (let i = 0; i < addresses.length; i++) {  
      const addr = addresses[i];

      if(iptool.isV4Format(addr) || iptool.isV6Format(addr)) {
        await rclient.zaddAsync(key, new Date() / 1000, addr)
        validAddresses.push(addr);
        updated = true
      }
    }
    await domainUpdater.updateDomainMapping(dns, validAddresses);
    
    if(updated === false && existing === false) {
      await rclient.zaddAsync(key, new Date() / 1000, firewalla.getRedHoleIP()); // red hole is a placeholder ip for non-existing domain
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

  async removeDns(ip, domain) {
    let key = this.getDNSKey(ip);
    await rclient.zremAsync(key, domain);
  }
}


module.exports = DNSTool;
