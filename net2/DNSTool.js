/*    Copyright 2016-2020 Firewalla Inc.
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

const sysManager = require('./SysManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

const iptool = require('ip')
const { Address4, Address6 } = require('ip-address')

const util = require('util');

const firewalla = require('../net2/Firewalla.js');

let instance = null;
const DomainUpdater = require('../control/DomainUpdater.js');
const domainUpdater = new DomainUpdater();

class DNSTool {

  constructor() {
    if (!instance) {
      instance = this;
      if (firewalla.isProduction()) {
        this.debugMode = false;
      } else {
        this.debugMode = true;
      }
    }
    return instance;
  }

  getDNSKey(ip) {
    return util.format("rdns:ip:%s", ip);
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
    const domain = await rclient.zrevrangeAsync(key, 0, 1); // get domain with latest timestamp
    if (domain && domain.length != 0)
      return domain[0];
    else
      return null;
  }

  async getAllDns(ip) {
    const key = this.getDNSKey(ip);
    const domains = await rclient.zrevrangeAsync(key, 0, -1);
    return domains || [];
  }

  isValidIP(ip) {
    const ip4 = new Address4(ip)
    const ip6 = new Address6(ip)
    if (ip4.isValid() && ip4.correctForm() != '0.0.0.0' || ip6.isValid() && ip6.correctForm() != '::')
      return true
    else
      return false
  }

  async addDns(ip, domain, expire) {
    expire = expire || 24 * 3600; // one day by default
    if (!this.isValidIP(ip))
      return;

    // do not record if *domain* is an IP
    if (this.isValidIP(domain))
      return;

    if (firewalla.isReservedBlockingIP(ip))
      return;
    if (!domain)
      return;

    domain = domain.toLowerCase();
    let key = this.getDNSKey(ip);
    const now = Math.ceil(Date.now() / 1000);
    await rclient.zaddAsync(key, now, domain);
    await rclient.expireAsync(key, expire);
  }

  // doesn't have to keep it long, it's only used for instant blocking

  async addReverseDns(domain, addresses, expire) {
    expire = expire || 24 * 3600; // one day by default
    domain = domain && domain.toLowerCase();
    addresses = addresses || []

    // do not record if *domain* is an IP
    if (this.isValidIP(domain))
      return;

    addresses = addresses.filter((addr) => {
      return addr && firewalla.isReservedBlockingIP(addr) != true
    })

    let key = this.getReverseDNSKey(domain)

    const existing = await this.reverseDNSKeyExists(domain)

    let updated = false
    const validAddresses = [];

    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];

      if (this.isValidIP(addr)) {
        await rclient.zaddAsync(key, new Date() / 1000, addr)
        validAddresses.push(addr);
        updated = true
      }
    }
    await domainUpdater.updateDomainMapping(domain, validAddresses);

    if (updated === false && existing === false) {
      await rclient.zaddAsync(key, new Date() / 1000, firewalla.getRedHoleIP()); // red hole is a placeholder ip for non-existing domain
    }

    await rclient.expireAsync(key, expire)
  }

  async getIPsByDomain(domain) {
    let key = this.getReverseDNSKey(domain)
    let ips = await rclient.zrangeAsync(key, "0", "-1") || [];
    return ips.filter(ip => !firewalla.isReservedBlockingIP(ip));
  }

  async getIPsByDomainPattern(dnsPattern) {
    let pattern = `rdns:domain:*.${dnsPattern}`

    let keys = await rclient.keysAsync(pattern)

    let list = []
    if (keys) {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        let l = await rclient.zrangeAsync(key, "0", "-1")
        list.push.apply(list, l)
      }
    }

    return list.filter(ip => !firewalla.isReservedBlockingIP(ip)).filter((v, i, a) => a.indexOf(v) === i);
  }

  async removeDns(ip, domain) {
    let key = this.getDNSKey(ip);
    await rclient.zremAsync(key, domain);
  }

  async getLinkedDomains(target, isDomainPattern) {
    isDomainPattern = isDomainPattern || false;
    // target can be either ip or domain
    if (!target)
      return [];
    if (this.isValidIP(target)) {
      // target is ip
      const domains = await this.getAllDns(target);
      return domains || [];
    } else {
      const domains = {}
      let addresses = [];
      if (!isDomainPattern) {
        domains[target] = 1;
        addresses = await this.getIPsByDomain(target);
      } else {
        addresses = await this.getIPsByDomainPattern(target);
      }
      if (addresses && Array.isArray(addresses)) {
        for (const address of addresses) {
          const linkedDomains = await this.getAllDns(address);
          for (const linkedDomain of linkedDomains)
            domains[linkedDomain] = 1;
        }
      }
      return Object.keys(domains);
    }
  }

  getDefaultDhcpRange(network) {
    let subnet = null;
    if (network === "alternative") {
      subnet = iptool.cidrSubnet(sysManager.mySubnet());
    }
    else if (network === "secondary") {
      const subnet2 = sysManager.mySubnet2() || "192.168.218.1/24";
      subnet = iptool.cidrSubnet(subnet2);
    }
    else if (network === "wifi") {
      const Config = require('./config.js');
      const fConfig = Config.getConfig(true);
      if (fConfig && fConfig.wifiInterface && fConfig.wifiInterface.iptool)
        subnet = iptool.cidrSubnet(fConfig.wifiInterface.iptool);
    }

    if (!subnet) {
      try {
        // try if network is already a cidr subnet
        subnet = iptool.cidrSubnet(network);
      } catch (err) {
        return null;
      }
    }

    const firstAddr = iptool.toLong(subnet.firstAddress);
    const lastAddr = iptool.toLong(subnet.lastAddress);
    const midAddr = firstAddr + (lastAddr - firstAddr) / 5;
    let rangeBegin = iptool.fromLong(midAddr);
    let rangeEnd = iptool.fromLong(lastAddr - 3);
    return {
      begin: rangeBegin,
      end: rangeEnd
    };
  }

}


module.exports = DNSTool;
