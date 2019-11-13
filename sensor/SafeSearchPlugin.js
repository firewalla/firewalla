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
const dnsConfigFolder = `${userConfigFolder}/dnsmasq`;
const safeSearchConfigFile = `${dnsConfigFolder}/safeSearch_system.conf`;

const configKey = "ext.safeSearch.config";

const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const domainBlock = require('../control/DomainBlock.js')();

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const fc = require('../net2/config.js');

const iptool = require('ip')

class SafeSearchPlugin extends Sensor {
  
  async run() {

    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.enabledMacAddresses = {};

    this.domainCaches = {};

    const exists = await this.configExists();

    if(!exists) {
      await this.setDefaultSafeSearchConfig();
    }

    extensionManager.registerExtension("safeSearch", this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

    //await exec(`mkdir -p ${devicemasqConfigFolder}`);

    sem.once('IPTABLES_READY', async () => {
      if(fc.isFeatureOn("safe_search")) {
        await this.globalOn();
      } else {
        await this.globalOff();
      }

      fc.onFeature("safe_search", async (feature, status) => {
        if(feature !== "safe_search") {
          return;
        }

        if(status) {
          await this.globalOn();
        } else {
          await this.globalOff();
        }
      })

      sem.on('SAFESEARCH_REFRESH', (event) => {
        this.applySafeSearch();
      });

      await this.job();
      this.timer = setInterval(async () => {
        return this.job();
      }, this.config.refreshInterval || 3600 * 1000); // one hour by default
    })
  }

  async job() {
    await this.updateAllDomains();
    await this.applySafeSearch();
  }

  async apiRun() {
    extensionManager.onSet("safeSearchConfig", async (msg, data) => {
      await rclient.setAsync(configKey, JSON.stringify(data));
      sem.sendEventToFireMain({
        type: 'SAFESEARCH_REFRESH'
      });
    });

    extensionManager.onGet("safeSearchConfig", async (msg, data) => {
      return this.getSafeSearchConfig();
    });
  }

  async getSafeSearchConfig() {
    const json = await rclient.getAsync(configKey);
    try {
      return JSON.parse(json);
    } catch(err) {
      log.error(`Got error when loading config from ${configKey}`);
      return {};
    }
  }

  async setDefaultSafeSearchConfig() {
    if(this.config && this.config.defaultConfig) {
      log.info("Setting default safe search config...");
      return rclient.setAsync(configKey, JSON.stringify(this.config.defaultConfig));
    }
  }

  async configExists() {
    const check = await rclient.typeAsync(configKey);
    return check !== 'none';
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying policy:", ip, policy)

    try {
      if(ip === '0.0.0.0') {
        if(policy && policy.state) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applySystemSafeSearch();
      } else {
        const macAddress = host && host.o && host.o.mac;
        if(macAddress) {
          if(policy && policy.state) {
            this.enabledMacAddresses[macAddress] = 1;
          } else {
            delete this.enabledMacAddresses[macAddress];
          }
          return this.applyDeviceSafeSearch(macAddress);
        }
      }
    } catch(err) {
      log.error("Got error when applying safesearch policy", err);
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
        case "on":
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

  getDNSMasqEntry(macAddress, ipAddress, domainToBeRedirect) {
    if(macAddress) {
      return `address=/${domainToBeRedirect}/${ipAddress}%${macAddress.toUpperCase()}`;
    } else {
      return `address=/${domainToBeRedirect}/${ipAddress}`;
    }

  }

  async loadDomainCache(domain) {
    const key = `rdns:domain:${domain}`;
    let results = await rclient.zrevrangebyscoreAsync(key, '+inf', '-inf');
    results = results.filter((ip) => !f.isReservedBlockingIP(ip));

    const ipv4Results = results.filter((ip) => iptool.isV4Format(ip))

    if(ipv4Results.length > 0) {
      return ipv4Results[0]; // return ipv4 address as a priority
    }

    if(results.length > 0) {
      log.info(`Domain ${domain} ======> ${results[0]}`);
      return results[0];
    }

    return null;
  }

  async updateDomainCache(domain) {
    return domainBlock.resolveDomain(domain);
  }

  getAllDomains() {
    const mappings = this.getDomainMapping();
    if(mappings) {
      const values = Object.values(mappings);
      const domains = [];
      values.forEach((value) => {
        if(value) {
          domains.push(...Object.keys(value));
        }
      });
      return domains;
    } else {
      return [];
    }
  }

  async updateAllDomains() {
    log.info("Updating all domains...");
    return Promise.all(this.getAllDomains().map(async domain => this.updateDomainCache(domain)));
  }

  // redirect targetDomain to the ip address of safe domain
  async generateConfig(macAddress, safeDomain, targetDomains) {
    const ip = await this.loadDomainCache(safeDomain);
    if(ip) {
      return targetDomains.map((targetDomain) => {
        return this.getDNSMasqEntry(macAddress, ip, targetDomain);
      })
    } else {
      return [];
    }
  }

  async applySafeSearch() {
    await this.applySystemSafeSearch();

    for(const macAddress in this.enabledMacAddresses) {
      await this.applyDeviceSafeSearch(macAddress)
    }
  }

  async applySystemSafeSearch() {
    if(this.systemSwitch && this.adminSystemSwitch) {
      const config = await this.getSafeSearchConfig();
      return this.systemStart(config);
    } else {
      return this.systemStop();
    }
  }

  async applyDeviceSafeSearch(macAddress) {
    log.info("Applying safe search on device", macAddress);

    try {
      if(this.enabledMacAddresses[macAddress] && this.adminSystemSwitch) {
        const config = await this.getSafeSearchConfig();
        return this.perDeviceStart(macAddress, config)
      } else {
        return this.perDeviceStop(macAddress);
      }
    } catch(err) {
      log.error(`Failed to apply safe search on device ${macAddress}, err: ${err}`);
    }
  }

  async generateConfigFile(macAddress, config) {
    let entries = [];

    for(const type in config) {
      const value = config[type];
      if(value === 'off') {
        continue;
      }

      const key = this.getMappingKey(type, value);
      const result = this.getMappingResult(key);
      if(result) {
        const safeDomains = Object.keys(result);
        await Promise.all(safeDomains.map(async (safeDomain) => {
          const targetDomains = result[safeDomain];
          const configs = await this.generateConfig(macAddress, safeDomain, targetDomains);
          entries.push(...configs);
        }));
      }
    }  

    entries.push("");

    //await fs.writeFileAsync(destinationFile, entries.join("\n"));
    return entries.join("\n");
  }

  async saveConfigFile(file, content) {
    return fs.writeFileAsync(file, content);
  }

  async loadConfigFile(file) {
    return fs.readFileAsync(file, {encoding: 'utf8'});
  }

  async deleteConfigFile(destinationFile) {
    return fs.unlinkAsync(destinationFile).catch(() => undefined);
  }

  // system level

  getConfigFile(macAddress) {
    if(macAddress) {
      return `${dnsConfigFolder}/safeSearch_${macAddress}.conf`;
    } else {
      return safeSearchConfigFile;
    }
  }

  async systemStart(config) {
    const configString = await this.generateConfigFile(undefined, config);
    const existingString = await this.loadConfigFile(this.getConfigFile()).catch((err) => null);
    if(configString !== existingString || existingString === null) {
      await this.saveConfigFile(this.getConfigFile(), configString);
      await dnsmasq.restartDnsmasq(); // Simply restart service, no need to touch iptables. Don't worry, this function has cool-down protection.
    }
    return;
  }

  async systemStop() {
    await this.deleteConfigFile(safeSearchConfigFile);
    await dnsmasq.restartDnsmasq(); // Simply restart service, no need to touch iptables. Don't worry, this function has cool-down protection.
  }

  async perDeviceStart(mac, config) {
    const configString = await this.generateConfigFile(mac, config);
    const existingString = await this.loadConfigFile(this.getConfigFile(mac)).catch((err) => null);
    if(configString !== existingString || existingString === null) {
      await this.saveConfigFile(this.getConfigFile(mac), configString);
      await dnsmasq.restartDnsmasq(); // Simply restart service, no need to touch iptables. Don't worry, this function has cool-down protection.
    }
  }

  async perDeviceStop(mac) {
    const file = this.getConfigFile(mac);
    await this.deleteConfigFile(file);
    await dnsmasq.restartDnsmasq(); // Simply restart service, no need to touch iptables. Don't worry, this function has cool-down protection.
  }

  // global on/off
  async globalOn() {
    this.adminSystemSwitch = true;
    await this.applySafeSearch();
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    await this.applySafeSearch();
  }
}

module.exports = SafeSearchPlugin
