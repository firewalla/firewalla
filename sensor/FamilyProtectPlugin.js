/*    Copyright 2016-2022 Firewalla Inc.
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

const extensionManager = require('./ExtensionManager.js')
const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const IdentityManager = require('../net2/IdentityManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const FALLBACK_FAMILY_DNS = ["8.8.8.8"]; // these are just backup servers
let FAMILY_DNS = null;
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const dns = require('dns');
const util = require('util');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const Constants = require('../net2/Constants.js');
const dnsmasq = new DNSMASQ();
const scheduler = require('../util/scheduler');
const dnsHealth = require('../util/DNSUpstreamHealthCheck.js');
const era = require('../event/EventRequestApi.js');

const featureName = "family_protect";
const policyKeyName = "family";
const configName = "familyConfig";
const configKey = "ext.family.config";

class FamilyProtectPlugin extends Sensor {
    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.macAddressSettings = {};
        this.networkSettings = {};
        this.tagSettings = {};
        this.identitySettings = {};
        this.healthCheckInterval = (this.config.healthCheckInterval || 60) * 1000;
        this.healthCheckTimeout = this.config.healthCheckTimeout || 3;
        this.healthCheckTries = this.config.healthCheckTries || 2;
        this.healthCheckFailThreshold = this.config.healthCheckFailThreshold || 4;
        this.healthCheckRecoverThreshold = this.config.healthCheckRecoverThreshold || 1;
        this.healthState = {
          healthy: true,
          bypassActive: false,
          failCount: 0,
          recoverCount: 0,
          lastError: null,
          lastCheckedAt: null,
          selectedServer: null
        };
        this.applyFamilyProtectSync = new scheduler.UpdateJob(this.applyFamilyProtect.bind(this), 0);
        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy,
            start: this.globalOn,
            stop: this.globalOff,
        });

        this.hookFeature(featureName);

        sem.on('FAMILY_REFRESH', (event) => {
          void this.applyFamilyProtectSync.exec(true, true, event.config || null)
        });

        sem.on('FAMILY_RESET', async () => {
          try {
            await fc.disableDynamicFeature(featureName)
            for (const tag in this.tagSettings) this.tagSettings[tag] = 0
            for (const uuid in this.networkSettings) this.networkSettings[uuid] = 0
            for (const mac in this.macAddressSettings) this.macAddressSettings[mac] = 0
            for (const guid in this.identitySettings) this.identitySettings[guid] = 0
            FAMILY_DNS = null
            await rclient.unlinkAsync(configKey)
            this.resetHealthState()
            await this.applyFamilyProtectSync.exec(true, true, null)
          } catch(err) {
            log.error('Error resetting family', err)
          }
        });

        if (this.healthCheckTask)
          clearInterval(this.healthCheckTask);
        this.healthCheckTask = setInterval(() => {
          this.applyFamilyProtectSync.exec(false, true, null).catch((err) => {
            log.error('Failed to run family health check', err);
          });
        }, this.healthCheckInterval);
    }

    async job() {
        await this.applyFamilyProtectSync.exec(true, true, null);
    }

    getDefaultFamilyConfig() {
      return {
        killSwitch: true
      };
    }

    async getFamilyConfig() {
      const str = await rclient.getAsync(configKey)
      try {
        const config = str ? JSON.parse(str) : null;
        return Object.assign({}, this.getDefaultFamilyConfig(), config || {});
      } catch (err) {
        log.error('Failed to parse family config', err);
        return this.getDefaultFamilyConfig();
      }
    }

    applyFamilyConfig(config) {
      const mergedConfig = Object.assign({}, this.getDefaultFamilyConfig(), config || {});
      FAMILY_DNS = Array.isArray(mergedConfig.servers) ? mergedConfig.servers.filter(Boolean) : null;
      return mergedConfig;
    }

    async setFamilyConfig(config) {
      const sanitized = Object.assign({}, config);
      if ('killSwitch' in sanitized && typeof sanitized.killSwitch !== 'boolean')
        delete sanitized.killSwitch;
      const currentConfig = await this.getFamilyConfig();
      const nextConfig = Object.assign({}, currentConfig, sanitized);
      this.applyFamilyConfig(nextConfig)
      await rclient.setAsync(configKey, JSON.stringify(nextConfig))
    }

    async apiRun() {
      extensionManager.onGet(configName, async (msg, data) => {
        const config = await this.getFamilyConfig(data)
        return  config
      });

      extensionManager.onSet(configName, async (msg, data) => {
        try {await extensionManager._precedeRecord(msg.id, {origin: await this.getFamilyConfig()})} catch(err) {};
        if (data) {
          await this.setFamilyConfig(data)
          sem.sendEventToFireMain({
            type: 'FAMILY_REFRESH',
            config: data,
          });
        }
      });

      extensionManager.onCmd('familyReset', async () => {
        sem.sendEventToFireMain({
          type: 'FAMILY_RESET',
        })
      });
      
      extensionManager.onCmd('familyDnsTest', async (msg, data) => {
        const maxServers = 10;
        const maxDomains = 20;
        // 64 bytes per server (IPv6+port worst case), 253 bytes per domain (RFC 1035 max FQDN)
        const maxPayloadBytes = maxServers * 64 + maxDomains * 253 + 1000;
        if (data && JSON.stringify(data).length > maxPayloadBytes)
          throw new Error(`payload exceeds limit of ${maxPayloadBytes} bytes`);
        const servers = data && data.servers;
        const domains = data && data.domains;
        if (!Array.isArray(servers) || servers.length === 0)
          throw new Error("servers is required");
        if (servers.length > maxServers)
          throw new Error(`servers exceeds limit of ${maxServers}`);
        if (!Array.isArray(domains) || domains.length === 0)
          throw new Error("domains is required");
        if (domains.length > maxDomains)
          throw new Error(`domains exceeds limit of ${maxDomains}`);

        const testOne = (server, domain) => new Promise((resolve) => {
          const resolver = new dns.Resolver();
          resolver.setServers([server]);
          const resolve4Async = util.promisify(resolver.resolve4.bind(resolver));
          const timer = setTimeout(() => {
            resolver.cancel();
            resolve({ domain, addresses: [], error: 'timeout' });
          }, 5000);
          resolve4Async(domain).then(
            (addresses) => { clearTimeout(timer); resolve({ domain, addresses }); },
            (err) => { clearTimeout(timer); resolve({ domain, addresses: [], error: err.message }); }
          );
        });

        return Promise.all(servers.map(async (server) => {
          const results = await Promise.all(domains.map(domain => testOne(server, domain)));
          return { server, results };
        }));
      });
    }

    resetHealthState() {
      this.healthState = Object.assign({}, this.healthState, {
        healthy: true,
        bypassActive: false,
        failCount: 0,
        recoverCount: 0,
        lastError: null,
        lastCheckedAt: null,
        selectedServer: null
      });
    }

    isFeatureActive() {
      return this.adminSystemSwitch === true && fc.isFeatureOn(featureName);
    }

    shouldRouteFeatureDns() {
      return this.isFeatureActive() && this.healthState.bypassActive !== true;
    }

    async getKillSwitchEnabled() {
      const config = await this.getFamilyConfig();
      return config.killSwitch !== false;
    }

    async getEffectiveFamilyServers() {
      const servers = await this.familyDnsAddr();
      return Array.isArray(servers) ? servers.filter(Boolean) : [];
    }

    getHealthCheckDomains() {
      return this.config.healthCheckDomains;
    }

    async probeFamilyHealth() {
      const servers = await this.getEffectiveFamilyServers();
      const results = await dnsHealth.probeServers(servers, {
        domains: this.getHealthCheckDomains(),
        timeout: this.healthCheckTimeout,
        tries: this.healthCheckTries
      });
      const summary = dnsHealth.summarizeProbeResults(results);
      return {
        servers,
        results,
        healthy: summary.healthy,
        selectedServer: summary.firstHealthy && summary.firstHealthy.server || null,
        error: summary.error || (servers.length === 0 ? 'no family dns server configured' : 'family dns health check failed')
      };
    }

    updateStableHealth(nextProbeHealthy) {
      if (nextProbeHealthy) {
        this.healthState.failCount = 0;
        if (this.healthState.healthy === true) {
          return true;
        }
        this.healthState.recoverCount += 1;
        if (this.healthState.recoverCount >= this.healthCheckRecoverThreshold) {
          this.healthState.recoverCount = 0;
          return true;
        }
        return false;
      }

      this.healthState.recoverCount = 0;
      this.healthState.failCount += 1;
      if (this.healthState.healthy === false)
        return false;
      if (this.healthState.failCount >= this.healthCheckFailThreshold)
        return false;
      return true;
    }

    async emitHealthState({ healthy, enabled, bypassActive, reason, target }) {
      const stateValue = enabled === false ? 2 : (healthy ? 0 : 1);
      await era.addStateEvent(Constants.STATE_EVENT_DNS_SERVICE, featureName, stateValue, {
        service: featureName,
        enabled,
        killSwitch: await this.getKillSwitchEnabled(),
        bypassActive,
        reason,
        target,
        error_value: 1
      });
    }

    async refreshFamilyHealthState() {
      if (!this.isFeatureActive()) {
        this.resetHealthState();
        await this.emitHealthState({
          healthy: true,
          enabled: false,
          bypassActive: false,
          reason: 'feature_disabled',
          target: ''
        });
        return;
      }

      const probeResult = await this.probeFamilyHealth();
      const stableHealthy = this.updateStableHealth(probeResult.healthy);
      const killSwitchEnabled = await this.getKillSwitchEnabled();
      const bypassActive = !stableHealthy && !killSwitchEnabled;
      this.healthState.healthy = stableHealthy;
      this.healthState.bypassActive = bypassActive;
      this.healthState.lastError = stableHealthy ? null : probeResult.error;
      this.healthState.lastCheckedAt = Date.now();
      this.healthState.selectedServer = probeResult.selectedServer;

      await this.emitHealthState({
        healthy: stableHealthy,
        enabled: true,
        bypassActive,
        reason: stableHealthy ? 'ok' : (probeResult.error || 'family_dns_unhealthy'),
        target: probeResult.selectedServer || probeResult.servers[0] || ''
      });
    }

    async checkFamilyHealth() {
      await this.applyFamilyProtectSync.exec(false, true, null);
    }

    async applyDnsmasqPolicyBindings() {
      await this.applySystemFamilyProtect();
      for (const macAddress in this.macAddressSettings) {
        await this.applyDeviceFamilyProtect(macAddress);
      }
      for (const tagUid in this.tagSettings) {
        const tagExists = await TagManager.tagUidExists(tagUid);
        if (!tagExists)
          this.tagSettings[tagUid] = 0;
        await this.applyTagFamilyProtect(tagUid);
        if (!tagExists)
          delete this.tagSettings[tagUid];
      }
      for (const uuid in this.networkSettings) {
        const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        if (!networkProfile)
          delete this.networkSettings[uuid];
        else
          await this.applyNetworkFamilyProtect(uuid);
      }
      for (const guid in this.identitySettings) {
        const identity = IdentityManager.getIdentityByGUID(guid);
        if (!identity)
          delete this.identitySettings[guid];
        else
          await this.applyIdentityFamilyProtect(guid);
      }
    }

    async applyPolicy(host, ip, policy) {
        log.info("Applying family protect policy:", ip, policy);
        try {
            if (ip === '0.0.0.0') {
                if (policy == true) {
                    this.systemSwitch = true;
                } else {
                    this.systemSwitch = false;
                }
                return this.applySystemFamilyProtect();
            } else {
                if (!host)
                  return;
                switch (host.constructor.name) {
                  case "Tag": {
                    const tagUid = host.o && host.o.uid;
                    if (tagUid) {
                      if (policy === true)
                        this.tagSettings[tagUid] = 1;
                      // false means unset, this is for backward compatibility
                      if (policy === false)
                        this.tagSettings[tagUid] = 0;
                      // null means disabled, this is for backward compatibility
                      if (policy === null)
                        this.tagSettings[tagUid] = -1;
                      await this.applyTagFamilyProtect(tagUid);
                    }
                    break;
                  }
                  case "NetworkProfile": {
                    const uuid = host.o && host.o.uuid
                    if (uuid) {
                      if (policy === true)
                        this.networkSettings[uuid] = 1;
                      if (policy === false)
                        this.networkSettings[uuid] = 0;
                      if (policy === null)
                        this.networkSettings[uuid] = -1;
                      await this.applyNetworkFamilyProtect(uuid);
                    }
                    break;
                  }
                  case "Host": {
                    const macAddress = host && host.o && host.o.mac;
                    if (macAddress) {
                      if (policy === true)
                        this.macAddressSettings[macAddress] = 1;
                      if (policy === false)
                        this.macAddressSettings[macAddress] = 0;
                      if (policy === null)
                        this.macAddressSettings[macAddress] = -1;
                      await this.applyDeviceFamilyProtect(macAddress);
                    }
                    break;
                  }
                  default: 
                  if (IdentityManager.isIdentity(host)) {
                    const guid = IdentityManager.getGUID(host);
                    if (guid) {
                      if (policy === true)
                        this.identitySettings[guid] = 1;
                      if (policy === false)
                        this.identitySettings[guid] = 0;
                      if (policy === null)
                        this.identitySettings[guid] = -1;
                      await this.applyIdentityFamilyProtect(guid);
                    }
                  }
                }

            }
        } catch (err) {
            log.error("Got error when applying family protect policy", err);
        }
    }

    async applyFamilyProtect(applyPolicies = true, refreshHealth = true, config = null) {
      try {
        if (config)
          this.applyFamilyConfig(config);

        const prevBypassActive = this.healthState.bypassActive;
        if (refreshHealth)
          await this.refreshFamilyHealthState();

        const configFilePath = `${dnsmasqConfigFolder}/${featureName}.conf`;
        const killSwitchEnabled = await this.getKillSwitchEnabled();
        const dnsaddrs = await this.getEffectiveFamilyServers();
        let selectedServer = null;
        if (this.isFeatureActive()) {
          if (this.healthState.bypassActive) {
            selectedServer = null;
          } else {
            selectedServer = this.healthState.selectedServer || dnsaddrs[0] || null;
          }
        }

        if (selectedServer) {
          const dnsmasqEntry = `server=${selectedServer}$${featureName}$*${Constants.DNS_DEFAULT_WAN_TAG}`;
          log.info(`Using family dns ${selectedServer}`)
          await dnsmasq.writeConfig(configFilePath, dnsmasqEntry);
        } else {
          await fs.unlinkAsync(configFilePath).catch((err) => {});
        }

        const bypassChanged = this.healthState.bypassActive !== prevBypassActive;
        if (applyPolicies || bypassChanged)
          await this.applyDnsmasqPolicyBindings();
      } catch(err) {
        log.error('Failed to apply family policy', err)
      }
    }

    async applySystemFamilyProtect() {
      if (this.systemSwitch && this.shouldRouteFeatureDns()) {
        return this.systemStart();
      } else {
        return this.systemStop();
      }
    }

    async applyTagFamilyProtect(tagUid) {
      if (this.tagSettings[tagUid] == 1)
        return this.shouldRouteFeatureDns() ? this.perTagStart(tagUid) : this.perTagStop(tagUid);
      if (this.tagSettings[tagUid] == -1)
        return this.perTagStop(tagUid);
      return this.perTagReset(tagUid);
    }

    async applyNetworkFamilyProtect(uuid) {
      if (this.networkSettings[uuid] == 1)
        return this.shouldRouteFeatureDns() ? this.perNetworkStart(uuid) : this.perNetworkStop(uuid);
      if (this.networkSettings[uuid] == -1)
        return this.perNetworkStop(uuid);
      return this.perNetworkReset(uuid);
    }

    async applyDeviceFamilyProtect(macAddress) {
      if (this.macAddressSettings[macAddress] == 1)
        return this.shouldRouteFeatureDns() ? this.perDeviceStart(macAddress) : this.perDeviceStop(macAddress);
      if (this.macAddressSettings[macAddress] == -1)
        return this.perDeviceStop(macAddress);
      return this.perDeviceReset(macAddress);
    }

    async applyIdentityFamilyProtect(guid) {
      if (this.identitySettings[guid] == 1)
        return this.shouldRouteFeatureDns() ? this.perIdentityStart(guid) : this.perIdentityStop(guid);
      if (this.identitySettings[guid] == -1)
        return this.perIdentityStop(guid);
      return this.perIdentityReset(guid);
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
      if (!networkProfile) {
        log.warn(`Network profile is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${uuid}.conf`;
      const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }

    async perNetworkStop(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile) {
        log.warn(`Network profile is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${uuid}.conf`;
      // explicit disable family protect
      const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }

    async perNetworkReset(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile) {
        log.warn(`Network profile is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${uuid}.conf`;
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
        await this.applyFamilyProtectSync.exec(true, true, null);
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        this.resetHealthState();
        await this.applyFamilyProtectSync.exec(true, true, null);
    }

  async familyDnsAddr() {
    if (FAMILY_DNS && FAMILY_DNS.length != 0) {
      return FAMILY_DNS.filter(Boolean);
    }
    const customConfig = await this.getFamilyConfig()
    if (customConfig && Array.isArray(customConfig.servers) && customConfig.servers.length > 0) {
      FAMILY_DNS = customConfig.servers.filter(Boolean)
      return FAMILY_DNS
    }
    const data = await f.getBoneInfoAsync()
    if (data && data.config && data.config.dns && Array.isArray(data.config.dns.familymode) && data.config.dns.familymode.length > 0) {
      FAMILY_DNS = data.config.dns.familymode.filter(Boolean)
      return FAMILY_DNS
    } else {
      return FALLBACK_FAMILY_DNS
    }
  }
}

module.exports = FamilyProtectPlugin
