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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const extensionManager = require('./ExtensionManager.js')

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsConfigFolder = `${userConfigFolder}/dns`;
const safeSearchConfigFile = `${dnsConfigFolder}/safeSearch.conf`;

const configKey = "ext.safeSearch.config";

const updateInterval = 3600 * 1000 // once per hour

const rclient = require('../util/redis_manager.js').getConfig();

const domainBlock = require('../control/DomainBlock.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const domainMapping = {
  youtube_strict: {
    "restrict.youtube.com": [
      "www.youtube.com",
      "m.youtube.com",
      "youtubei.googleapis.com",
      "youtube.googleapis.com",
      "www.youtube-nocookie.com"
    ]
  },
  youtube_moderate: {
    "restrictmoderate.youtube.com": [
      "www.youtube.com",
      "m.youtube.com",
      "youtubei.googleapis.com",
      "youtube.googleapis.com",
      "www.youtube-nocookie.com"
    ]
  },
  google: {
    "forcesafesearch.google.com": [
      "www.google.com"
    ]
  },
  bing: {
    "strict.bing.com": [
      "www.bing.com"
    ]
  }
}

class SafeSearchPlugin extends Sensor {

  scheduledJob() {
    if(ipv6.hasConfig() &&
       ipv6.config.updatePublicIP) {
      ipv6.updatePublicIP()
    }
  }
  
  run() {
    this.cachedDomainResult = {};

    extensionManager.registerExtension("safeSearch", this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    })
  }

  async applyPolicy(policy) {
    log.info("Applying policy:", policy)

    const state = policy && policy.state;

    if(state === true) {
      return this.start(policy.config)
    } else {
      return this.stop();
    }  
  }
  
  // {
  //   google: "on", // "on", "off"
  //   youtube: "strict", // "strict", "moderate", "off"
  //   bing: "on" // "on", "off"
  // }

  getMappingKey(type, value) {
    switch(type) {
    case "google":
      return "google";
    case "bing":
      return "bing";
    case "youtube":
      switch(value) {
        case "strict":
          return "youtube_strict";
        case "moderate":
          return "youtube_moderate";
        default:
          return null;
      }
    default:
      return null;
    }
  }

  getMappingResult(key) {
    if(key) {
      return domainMapping[key];
    } else {
      return null;
    }
  }

  addToCache(domain ,result) {
    if(this.cachedDomainResult[domain]) {
      // do nothing
      return;
    }

    this.cachedDomainResult[domain] = result;

    setTimeout(() => {
      delete this.cachedDomainResult[domain];
    }, updateInterval);
  }

  async getDNSMasqEntry(domainToBeRedirect, ipAddress) {
    return `address=/${domainToBeRedirect}/${ipAddress}`;
  }

  async processMappingResult(mappingEntry) {
    const safeDomains = Object.keys(mappingEntry);

    const entries = await Promise.all(safeDomains.map(async (safeDomain) => {
      const ips = await domainBlock.resolveDomain(safeDomain);

      if(ips.length > 0) {
        const ip = ips[0];
        const domainsToBeRedirect = mappingEntry[safeDomain];
        await Promise.all(domainsToBeRedirect.map(async (domain) => {
          return this.getDNSMasqEntry(domain, ip);
        }));
      }      
    }));

    const concat = (x,y) => x.concat(y)
    const flatMap = (f,xs) => xs.map(f).reduce(concat, [])

    const flattedEntries = flatMap(x => x, entries);

    return flattedEntries;
  }

  async generateConfigFile(config) {
    let entries = [];

    for(const type in config) {
      const value = config[type];
      if(value === 'off') {
        continue;
      }
      
      const key = this.getMappingKey(type, value);
      const result = this.getMappingResult(key);
      if(result) {
        entries = entries.concat(this.processMappingResult(result));
      }
    }

    await fs.writeFileAsync(safeSearchConfigFile, JSON.stringify(entries.join("\n")));
  }

  async deleteConfigFile() {
    return fs.unlinkAsync(safeSearchConfigFile).catch(() => undefined);
  }

  async start(config) {
    await this.generateConfigFile(config);
    await dnsmasq.start(true);
    return;
  }

  async stop() {
    await this.deleteConfigFile();
    await dnsmasq.start(true);
  }
}

module.exports = SafeSearchPlugin
