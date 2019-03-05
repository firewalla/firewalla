/*    Copyright 2019 Firewalla LLC
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

const devicemasqConfigFolder = `${userConfigFolder}/devicemasq`;

const pidFile = `${f.getRuntimeInfoFolder()}/safeSearch.dnsmasq.pid`;

const configKey = "ext.safeSearch.config";

const updateInterval = 3600 * 1000 // once per hour

const rclient = require('../util/redis_manager.js').getRedisClient();

const domainBlock = require('../control/DomainBlock.js')();

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const safeSearchDNSPort = 8863;

class SafeSearchPlugin extends Sensor {
  
  async run() {
    this.cachedDomainResult = {};

    extensionManager.registerExtension("safeSearch", this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

    await exec(`mkdir -p ${devicemasqConfigFolder}`);
  }

  async apiRun() {
    extensionManager.onSet("safeSearchConfig", async (msg, data) => {
      return rclient.setAsync(configKey, JSON.stringify(data));
    });

    extensionManager.onGet("safeSearchConfig", async (msg, data) => {
      return this.getSafeSearchConfig();
    });
  }

  async getSafeSearchConfig() {
    const json = rclient.getAsync(configKey);
    try {
      return JSON.parse(json);
    } catch(err) {
      return {};
    }
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying policy:", policy)

    try {
      if(ip === '0.0.0.0') {
        return this.systemApplyPolicy(host, ip, policy);
      } else {
        return this.perDeviceApplyPolicy(host, ip, policy);
      }
    } catch(err) {
      log.error("Got error when applying safesearch policy", err);
    }

  }
  
  async systemApplyPolicy(host, ip, policy) {
    const state = policy && policy.state;
    const config = await this.getSafeSearchConfig();

    if(state === true) {
      return this.systemStart(config)
    } else {
      return this.systemStop();
    }  
  }

  async perDeviceApplyPolicy(host, ip, policy) {
    const state = policy && policy.state;
    const config = await this.getSafeSearchConfig();

    if(state === true) {
      return this.perDeviceStart(host, config)
    } else {
      return this.perDeviceStop(host);
    }
  }
  
  // {
  //   google: "on", // "on", "off"
  //   youtube: "strict", // "strict", "moderate", "off"
  //   bing: "on" // "on", "off"
  // }

  getMappingKey(type, value) {
    switch(type) {
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
      return type;
    }
  }

  getMappingResult(key) {
    if(key) {
      const mapping = this.getDomainMapping();
      if(!mapping) {
        return null;
      }
      return mapping[key];
    } else {
      return null;
    }
  }

  getDomainMapping() {
    return this.config && this.config.mapping;
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

  async getDNSMasqEntry(domainToBeRedirect, ipAddress, macAddress) {
    if(macAddress) {
      return `address=/${domainToBeRedirect}/${ipAddress}$${macAddress.toUpperCase()}`;
    } else {
      return `address=/${domainToBeRedirect}/${ipAddress}`;
    }

  }

  async processMappingResult(mappingEntry, macAddress) {
    const safeDomains = Object.keys(mappingEntry);

    const entries = await Promise.all(safeDomains.map(async (safeDomain) => {
      const ips = await domainBlock.resolveDomain(safeDomain);

      if(ips.length > 0) {
        const ip = ips[0];
        const domainsToBeRedirect = mappingEntry[safeDomain];
        return Promise.all(domainsToBeRedirect.map(async (domain) => {
          return this.getDNSMasqEntry(domain, ip, macAddress);
        }));
      } else {
        return [];
      }
    }));

    const concat = (x,y) => x.concat(y)
    const flatMap = (f,xs) => xs.map(f).reduce(concat, [])

    const flattedEntries = flatMap(x => x, entries);

    return flattedEntries;
  }

  async generateConfigFile(macAddress, config, destinationFile) {
    let entries = [];

    for(const type in config) {
      const value = config[type];
      if(value === 'off') {
        continue;
      }

      const key = this.getMappingKey(type, value);
      const result = this.getMappingResult(key);
      if(result) {
        const thisEntries = await this.processMappingResult(result, macAddress);
        entries = entries.concat(thisEntries);
      }      
    }  

    entries.push("");

    await fs.writeFileAsync(destinationFile, entries.join("\n"));
  }

  async deleteConfigFile(destinationFile) {
    return fs.unlinkAsync(destinationFile).catch(() => undefined);
  }

  // system level

  async systemStart(config) {
    await this.generateConfigFile(undefined, config, safeSearchConfigFile);
    await dnsmasq.start(true);
    return;
  }

  async systemStop() {
    await this.deleteConfigFile(safeSearchConfigFile);
    await dnsmasq.start(true);
  }

  /*
   * Safe Search DNS server will use local primary dns server as upstream server
   */
  async startDeviceMasq() {
    return exec("sudo systemctl restart devicemasq");
  }

  async stopDeviceMasq() {
    return exec("sudo systemctl stop devicemasq");
  }

  async isDeviceMasqRunning() {
    try {
      await exec("systemctl is-active devicemasq");
    } catch(err) {
      return false;
    }

    return true;
  }

  /*
   * Iptables setup per device, safe search is on when 
   */

  getPerDeviceConfigFile(macAddress) {
    return `${devicemasqConfigFolder}/safeSearch_${macAddress}.conf`;
  }

  async perDeviceStart(host, config) {
    if(!host.mac) {
      // do nothing
      return;
    }

    const file = this.getPerDeviceConfigFile(host.mac);
    await this.generateConfigFile(host.mac, config, file);
    await exec(`sudo ipset add devicedns_mac_set ${host.mac}`);
    await this.startDeviceMasq();
  }

  async perDeviceStop(host) {
    if(!host.mac) {
      // do nothing
      return;
    }

    const file = this.getPerDeviceConfigFile(host.mac);
    await this.deleteConfigFile(file);
    await exec(`sudo ipset del devicedns_mac_set ${host.mac}`);
    await this.startDeviceMasq();
  }
}

module.exports = SafeSearchPlugin
