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

let log = require('../net2/logger.js')(__filename, 'info');

let Hook = require('./Hook.js');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let country = require('../extension/country/country.js');

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let DNSManager = require('../net2/DNSManager.js');
let dnsManager = new DNSManager('info');

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

class DestIPFoundHook extends Hook {

  constructor() {
    super();

    this.config.intelExpireTime = 7 * 24 * 3600; // one week
    this.pendingIPs = {};
  }

  aggregateIntelResult(ip, sslInfo, dnsInfo, cloudIntelInfos) {
    let intel = {
      ip: ip
    };

    // dns
    if(sslInfo && sslInfo.server_name) {
      intel.host = sslInfo.server_name
    } else if(dnsInfo && dnsInfo.host) {
      intel.host = dnsInfo.host;
    }

    // app
    cloudIntelInfos.forEach((info) => {
      if(info.ip === ip || info.ip === intel.host) {
        if(info.apps) {
          intel.apps = JSON.stringify(info.apps);
        }

        if(info.c) {
          intel.category = info.c;
        }
      }
    });

    return intel;
  }

  getDomains(sslInfo, dnsInfo) {
    let domain = sslInfo && sslInfo.server_name;
    if(!domain) {
      domain = dnsInfo && dnsInfo.host;
    }

    let domains = [];
    if(domain)
      domains.push(domain);

    return domains;
  }

  enrichCountry(ip) {
    return country.getCountry(ip);
  }

  processIP(ip, notUpdateDB) {
    return async(() => {
      let result = await (intelTool.intelExists(ip));

      if(result) {
        return;
      }

      log.info("Found new IP " + ip + ", checking intels...");

      let sslInfo = await (intelTool.getSSLCertificate(ip));
      let dnsInfo = await (intelTool.getDNS(ip));

      let domains = this.getDomains(sslInfo, dnsInfo);
      let ips = [ip];

      let cloudIntelInfo = await (intelTool.checkIntelFromCloud(ips, domains));

      // Update intel dns:ip:xxx.xxx.xxx.xxx so that legacy can use it for better performance
      if(!notUpdateDB) {
        await (intelTool.updateIntelKeyInDNS(ip, cloudIntelInfo, this.config.intelExpireTime));
      }

      let aggrIntelInfo = this.aggregateIntelResult(ip, sslInfo, dnsInfo, cloudIntelInfo);
      aggrIntelInfo.country = this.enrichCountry(ip);

      if(!notUpdateDB) {
        await (intelTool.addIntel(ip, aggrIntelInfo, this.config.intelExpireTime));
      }

      return aggrIntelInfo;
    })()
  }

  run() {
    sem.on('DestIPFound', (event) => {

      let ip = event.ip;

      if(!ip)
        return;

      if(this.pendingIPs[ip])
        return; // already on the way of getting intel

      this.pendingIPs[ip] = 1;

      this.processIP(ip)
        .then(() => {
          if(this.pendingIPs[ip])
            delete this.pendingIPs[ip];
        })
        .catch((err) => {
          if(this.pendingIPs[ip])
            delete this.pendingIPs[ip];
      });

    });
  }
}

module.exports = DestIPFoundHook;
