/*    Copyright 2016 - 2020 Firewalla Inc.
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
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const configKey = "ext.safeSearch.config";

const rclient = require('../util/redis_manager.js').getRedisClient();

const domainBlock = require('../control/DomainBlock.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const featureName = "safe_search";
const policyKeyName = "safeSearch";

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const IdentityManager = require('../net2/IdentityManager.js');

const iptool = require('ip')

class SafeSearchPlugin extends Sensor {

  async run() {

    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.macAddressSettings = {};
    this.networkSettings = {};
    this.tagSettings = {};
    this.identitySettings = {};

    this.domainCaches = {};

    const exists = await this.configExists();

    if(!exists) {
      await this.setDefaultSafeSearchConfig();
    }

    extensionManager.registerExtension(policyKeyName, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

    this.hookFeature(featureName);

    sem.on('SAFESEARCH_REFRESH', (event) => {
      this.applySafeSearch();
    });
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
    log.info("Applying safesearch policy:", ip, policy)

    try {
      if(ip === '0.0.0.0') {
        if(policy && policy.state) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applySystemSafeSearch();
      } else {
        if (!host)
          return;
        switch (host.constructor.name) {
          case "Tag": {
            const tagUid = host.o && host.o.uid;
            if (tagUid) {
              if (policy && policy.state === true)
                this.tagSettings[tagUid] = 1;
              // false means unset, this is for backward compatibility
              if (policy && policy.state === false)
                this.tagSettings[tagUid] = 0;
              // null means disabled, this is for backward compatibility
              if (policy && policy.state === null)
                this.tagSettings[tagUid] = -1;
              await this.applyTagSafeSearch(tagUid);
            }
            break;
          }
          case "NetworkProfile": {
            const uuid = host.o && host.o.uuid;
            if (uuid) {
              if (policy && policy.state === true)
                this.networkSettings[uuid] = 1;
              if (policy && policy.state === false)
                this.networkSettings[uuid] = 0;
              if (policy && policy.state === null)
                this.networkSettings[uuid] = -1;
              await this.applyNetworkSafeSearch(uuid);
            }
            break;
          }
          case "Host" : {
            const macAddress = host && host.o && host.o.mac;
            if (macAddress) {
              if (policy && policy.state === true)
                this.macAddressSettings[macAddress] = 1;
              if (policy && policy.state === false)
                this.macAddressSettings[macAddress] = 0;
              if (policy && policy.state === null)
                this.macAddressSettings[macAddress] = -1;
              await this.applyDeviceSafeSearch(macAddress);
            }
            break;
          }
          default:
            if (IdentityManager.isIdentity(host)) {
              const guid = IdentityManager.getGUID(host);
              if (guid) {
                if (policy && policy.state === true)
                  this.identitySettings[guid] = 1;
                if (policy && policy.state === false)
                  this.identitySettings[guid] = 0;
                if (policy && policy.state === null)
                  this.identitySettings[guid] = -1;
                await this.applyIdentitySafeSearch(guid);
              }
            }
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

  getDNSMasqEntry(ipAddress, domainToBeRedirect) {
    return `address=/${domainToBeRedirect}/${ipAddress}$${featureName}`;
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
  async generateDomainEntries(safeDomain, targetDomains) {
    const ip = await this.loadDomainCache(safeDomain);
    if(ip) {
      return targetDomains.map((targetDomain) => {
        return this.getDNSMasqEntry(ip, targetDomain);
      })
    } else {
      return [];
    }
  }

  async applySafeSearch() {
    const configFilePath = `${dnsmasqConfigFolder}/${featureName}.conf`;
    if (this.adminSystemSwitch) {
      const config = await this.getSafeSearchConfig();
      const entries = await this.generateDnsmasqEntries(config);
      await fs.writeFileAsync(configFilePath, entries);
    } else {
      await fs.unlinkAsync(configFilePath).catch((err) => {});
    }

    await this.applySystemSafeSearch();
    for(const macAddress in this.macAddressSettings) {
      await this.applyDeviceSafeSearch(macAddress);
    }
    for (const tagUid in this.tagSettings) {
      const tag = TagManager.getTagByUid(tagUid);
      if (!tag)
        // reset tag if it is already deleted
        this.tagSettings[tagUid] = 0;
      await this.applyTagSafeSearch(tagUid);
      if (!tag)
        delete this.tagSettings[tagUid];
    }
    for (const uuid in this.networkSettings) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile)
        delete this.networkSettings[uuid];
      else
        await this.applyNetworkSafeSearch(uuid);
    }
    for (const guid in this.identitySettings) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (!identity)
        delete this.identitySettings[guid];
      else
        await this.applyIdentitySafeSearch(guid);
    }
  }

  async applySystemSafeSearch() {
    if(this.systemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async applyTagSafeSearch(tagUid) {
    if (this.tagSettings[tagUid] == 1)
      return this.perTagStart(tagUid);
    if (this.tagSettings[tagUid] == -1)
      return this.perTagStop(tagUid);
    return this.perTagReset(tagUid);
  }

  async applyNetworkSafeSearch(uuid) {
    if (this.networkSettings[uuid] == 1)
      return this.perNetworkStart(uuid);
    if (this.networkSettings[uuid] == -1)
      return this.perNetworkStop(uuid);
    return this.perNetworkReset(uuid);
  }

  async applyDeviceSafeSearch(macAddress) {
    if (this.macAddressSettings[macAddress] == 1)
      return this.perDeviceStart(macAddress);
    if (this.macAddressSettings[macAddress] == -1)
      return this.perDeviceStop(macAddress);
    return this.perDeviceReset(macAddress);
  }

  async applyIdentitySafeSearch(guid) {
    if (this.identitySettings[guid] == 1)
      return this.perIdentityStart(guid);
    if (this.identitySettings[guid] == -1)
      return this.perIdentityStop(guid);
    return this.perIdentityReset(guid);
  }

  async generateDnsmasqEntries(config) {
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
          const configs = await this.generateDomainEntries(safeDomain, targetDomains);
          while (configs.length) entries.push(configs.pop());
        }));
      }
    }

    entries.push("");
    return entries.join("\n");
  }

  async systemStart() {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async systemStop() {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStart(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStop(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\n`; // match negative tag
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagReset(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    await fs.unlinkAsync(configFile).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async perNetworkStart(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
    if (!iface) {
      log.warn(`Interface name is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
    const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perNetworkStop(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
    if (!iface) {
      log.warn(`Interface name is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
    // explicit disable family protect
    const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perNetworkReset(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
    if (!iface) {
      log.warn(`Interface name is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStart(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStop(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceReset(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async perIdentityStart(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityStop(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityReset(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => { });
      dnsmasq.scheduleRestartDNSService();
    }
  }

  // global on/off
  async globalOn() {
    this.adminSystemSwitch = true;
    await this.updateAllDomains();
    await this.applySafeSearch();
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    await this.applySafeSearch();
  }
}

module.exports = SafeSearchPlugin
