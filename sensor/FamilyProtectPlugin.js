/*    Copyright 2016-2025 Firewalla Inc.
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
const DnsServicePluginBase = require('./base/DnsServicePluginBase.js');
const HealthCheckMixin = require('./base/HealthCheckMixin.js');

const extensionManager = require('./ExtensionManager.js');
const IdentityManager = require('../net2/IdentityManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const scheduler = require('../util/scheduler');
const dnsHealth = require('../util/DNSUpstreamHealthCheck.js');

const dns = require('dns');
const util = require('util');
const Promise = require('bluebird');

const featureName = "family_protect";
const policyKeyName = "family";
const configName = "familyConfig";
const configKey = "ext.family.config";

const FALLBACK_FAMILY_DNS = ["8.8.8.8"];
let FAMILY_DNS = null;

class FamilyProtectPlugin extends HealthCheckMixin(DnsServicePluginBase) {

  get _defaultHealthCheckTimeout() { return 3; }
  get _defaultHealthCheckTries() { return 2; }
  get _defaultHealthCheckFailThreshold() { return 4; }

  async run() {
    this._init(featureName, `${f.getUserConfigFolder()}/dnsmasq`, policyKeyName);
    this.applyFamilyProtectSync = new scheduler.UpdateJob(this.applyFamilyProtect.bind(this), 0);

    sem.on('FAMILY_REFRESH', (event) => {
      void this.applyFamilyProtectSync.exec(event.config || null);
    });

    sem.on('FAMILY_RESET', async () => {
      try {
        await this._resetState();
        FAMILY_DNS = null;
        await rclient.unlinkAsync(configKey);
        await this.applyFamilyProtectSync.exec(null);
      } catch(err) {
        log.error('Error resetting family', err);
      }
    });
  }

  async job() {
    await this.applyFamilyProtectSync.exec(null);
  }

  getDefaultFamilyConfig() {
    return { killSwitch: true };
  }

  async getFamilyConfig() {
    const str = await rclient.getAsync(configKey);
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
    this.applyFamilyConfig(nextConfig);
    await rclient.setAsync(configKey, JSON.stringify(nextConfig));
  }

  async apiRun() {
    extensionManager.onGet(configName, async (msg, data) => {
      return this.getFamilyConfig(data);
    });

    extensionManager.onSet(configName, async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: await this.getFamilyConfig()})} catch(err) {};
      if (data) {
        await this.setFamilyConfig(data);
        sem.sendEventToFireMain({ type: 'FAMILY_REFRESH', config: data });
      }
    });

    extensionManager.onCmd('familyReset', async () => {
      sem.sendEventToFireMain({ type: 'FAMILY_RESET' });
    });

    extensionManager.onCmd('familyDnsTest', async (msg, data) => {
      const maxServers = 10;
      const maxDomains = 20;
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

  async getKillSwitchEnabled() {
    const config = await this.getFamilyConfig();
    return config.killSwitch !== false;
  }

  async getEffectiveFamilyServers() {
    const servers = await this.familyDnsAddr();
    return Array.isArray(servers) ? servers.filter(Boolean) : [];
  }

  async _getUpstreamServer() {
    return this.healthState.server || (await this.getEffectiveFamilyServers())[0] || null;
  }

  async probeHealth() {
    const servers = await this.getEffectiveFamilyServers();
    const results = await dnsHealth.probeServers(servers, {
      domains: this.getHealthCheckDomains(),
      timeout: this.healthCheckTimeout,
      tries: this.healthCheckTries
    });
    const summary = dnsHealth.summarizeProbeResults(results);
    return {
      healthy: summary.healthy,
      target: (summary.firstHealthy && summary.firstHealthy.server) || servers[0] || null,
      error: summary.error || (servers.length === 0 ? 'no family dns server configured' : 'family dns health check failed')
    };
  }

  async applyFamilyProtect(config = null) {
    try {
      if (config) {
        this.applyFamilyConfig(config);
        this.healthState.server = null;  // force _getUpstreamServer() to re-evaluate with new servers
      }
      await this.syncDnsmasqUpstreamConfig();
      await this.applyDnsmasqPolicyBindings();
    } catch(err) {
      log.error('Failed to apply family policy', err);
    }
  }

  // TODO: FamilyProtect policy: true/false/null, DoH/Unbound policy: { state: true/false/null }, if they are same, we can extract this function to base.
  async applyPolicy(host, ip, policy) {
    log.info("Applying family protect policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        this.systemSwitch = policy == true;
        return this.applySystemPolicy();
      }
      if (!host) return;
      switch (host.constructor.name) {
        case "Tag": {
          const tagUid = host.o && host.o.uid;
          if (tagUid) {
            if (policy === true)  this.tagSettings[tagUid] = 1;
            if (policy === false) this.tagSettings[tagUid] = 0;
            if (policy === null)  this.tagSettings[tagUid] = -1;
            await this.applyTagPolicy(tagUid);
          }
          break;
        }
        case "NetworkProfile": {
          const uuid = host.o && host.o.uuid;
          if (uuid) {
            if (policy === true)  this.networkSettings[uuid] = 1;
            if (policy === false) this.networkSettings[uuid] = 0;
            if (policy === null)  this.networkSettings[uuid] = -1;
            await this.applyNetworkPolicy(uuid);
          }
          break;
        }
        case "Host": {
          const macAddress = host && host.o && host.o.mac;
          if (macAddress) {
            if (policy === true)  this.macAddressSettings[macAddress] = 1;
            if (policy === false) this.macAddressSettings[macAddress] = 0;
            if (policy === null)  this.macAddressSettings[macAddress] = -1;
            await this.applyDevicePolicy(macAddress);
          }
          break;
        }
        default:
          if (IdentityManager.isIdentity(host)) {
            const guid = IdentityManager.getGUID(host);
            if (guid) {
              if (policy === true)  this.identitySettings[guid] = 1;
              if (policy === false) this.identitySettings[guid] = 0;
              if (policy === null)  this.identitySettings[guid] = -1;
              await this.applyIdentityPolicy(guid);
            }
          }
      }
    } catch (err) {
      log.error("Got error when applying family protect policy", err);
    }
  }

  // global on/off
  async globalOn() {
    this.featureSwitch = true;
    await this.applyFamilyProtectSync.exec(null);
  }

  async globalOff() {
    this.featureSwitch = false;
    this.resetHealthState();
    await this.applyFamilyProtectSync.exec(null);
  }

  async familyDnsAddr() {
    if (FAMILY_DNS && FAMILY_DNS.length != 0) {
      return FAMILY_DNS.filter(Boolean);
    }
    const customConfig = await this.getFamilyConfig();
    if (customConfig && Array.isArray(customConfig.servers) && customConfig.servers.length > 0) {
      FAMILY_DNS = customConfig.servers.filter(Boolean);
      return FAMILY_DNS;
    }
    const data = await f.getBoneInfoAsync();
    if (data && data.config && data.config.dns && Array.isArray(data.config.dns.familymode) && data.config.dns.familymode.length > 0) {
      FAMILY_DNS = data.config.dns.familymode.filter(Boolean);
      return FAMILY_DNS;
    } else {
      return FALLBACK_FAMILY_DNS;
    }
  }
}

module.exports = FamilyProtectPlugin;
