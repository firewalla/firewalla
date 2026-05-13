/*    Copyright 2022-2023 Firewalla Inc.
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
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;
const unboundLocalConfigFolder = `${userConfigFolder}/unbound_local`;

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const IdentityManager = require('../net2/IdentityManager.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const featureName = "unbound";
const scheduler = require('../util/scheduler');
const unbound = require('../extension/unbound/unbound');
const Constants = require('../net2/Constants.js');
const dnsHealth = require('../util/DNSUpstreamHealthCheck.js');
const era = require('../event/EventRequestApi.js');

class UnboundPlugin extends Sensor {
  async run() {
    this.systemSwitch = false;
    this.featureSwitch = false;
    this.networkSettings = {};
    this.tagSettings = {};
    this.macAddressSettings = {};
    this.identitySettings = {};
    this.healthCheckInterval = (this.config.healthCheckInterval || 60) * 1000;
    this.healthCheckTimeout = this.config.healthCheckTimeout || 2;
    this.healthCheckTries = this.config.healthCheckTries || 1;
    this.healthCheckFailThreshold = this.config.healthCheckFailThreshold || 3;
    this.healthCheckRecoverThreshold = this.config.healthCheckRecoverThreshold || 1;
    this.healthState = {
      healthy: true,
      bypassActive: false,
      failCount: 0,
      recoverCount: 0,
      lastError: null,
      lastCheckedAt: null
    };
    this.applyUnboundSync = new scheduler.UpdateJob(this.applyUnbound.bind(this), 0);

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.globalOn,
      stop: this.globalOff,
    });

    await exec(`mkdir -p ${dnsmasqConfigFolder}`);
    await exec(`mkdir -p ${unboundLocalConfigFolder}`);

    this.hookFeature(featureName);

    sem.on('UNBOUND_REFRESH', (event) => {
      void this.applyUnboundSync.exec(true, true, true);
    });

    sem.on('UNBOUND_RESET', async (event) => {
      try {
        await fc.disableDynamicFeature(featureName)
        for (const tag in this.tagSettings) this.tagSettings[tag] = 0
        for (const uuid in this.networkSettings) this.networkSettings[uuid] = 0
        for (const mac in this.macAddressSettings) this.macAddressSettings[mac] = 0
        for (const guid in this.identitySettings) this.identitySettings[guid] = 0
        await unbound.reset();
        this.resetHealthState();
        await this.applyUnboundSync.exec(true, true, true)
      } catch(err) {
        log.error('Error reseting unbound', err)
      }
    });

    if (this.healthCheckTask)
      clearInterval(this.healthCheckTask);
    this.healthCheckTask = setInterval(() => {
      this.applyUnboundSync.exec(false, false, true).catch((err) => {
        log.error('Failed to run Unbound health check', err);
      });
    }, this.healthCheckInterval);
  }

  async apiRun() {
    extensionManager.onSet("unboundConfig", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: await unbound.getConfig()})} catch(err) {};
      if (data) {
        const sanitized = Object.assign({}, data);
        if ('killSwitch' in sanitized && typeof sanitized.killSwitch !== 'boolean')
          delete sanitized.killSwitch;
        await unbound.updateUserConfig(sanitized);
        sem.sendEventToFireMain({
          type: 'UNBOUND_REFRESH'
        });
      }
    });

    extensionManager.onGet("unboundConfig", async (msg, data) => {
      const config = await unbound.getConfig();
      return config;
    });

    extensionManager.onCmd("unboundReset", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: {config: await unbound.getConfig(), enabled: fc.isFeatureOn(featureName)}})} catch(err) {};
      sem.sendEventToFireMain({
        type: 'UNBOUND_RESET'
      });
    });
  }

  resetHealthState() {
    this.healthState = Object.assign({}, this.healthState, {
      healthy: true,
      bypassActive: false,
      failCount: 0,
      recoverCount: 0,
      lastError: null,
      lastCheckedAt: null
    });
  }

  isFeatureActive() {
    return this.featureSwitch === true && fc.isFeatureOn(featureName);
  }

  shouldRouteFeatureDns() {
    return this.isFeatureActive() && this.healthState.bypassActive !== true;
  }

  async getKillSwitchEnabled() {
    const config = await unbound.getConfig();
    return config.killSwitch !== false;
  }

  getHealthCheckDomains() {
    return this.config.healthCheckDomains;
  }

  async probeUnboundHealth() {
    return dnsHealth.probeLocalServer('127.0.0.1', unbound.getLocalPort(), {
      domains: this.getHealthCheckDomains(),
      timeout: this.healthCheckTimeout,
      tries: this.healthCheckTries
    });
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

  async syncDnsmasqUpstreamConfig() {
    const configFilePath = `${dnsmasqConfigFolder}/${featureName}.conf`;
    const killSwitchEnabled = await this.getKillSwitchEnabled();
    const shouldAdvertise = this.isFeatureActive() && (this.healthState.healthy || killSwitchEnabled);
    if (shouldAdvertise) {
      const dnsmasqEntry = `server=${unbound.getLocalServer()}$${featureName}$*${Constants.DNS_DEFAULT_WAN_TAG}`;
      await dnsmasq.writeConfig(configFilePath, dnsmasqEntry);
    } else {
      await fs.unlinkAsync(configFilePath).catch((err) => { });
    }
    dnsmasq.scheduleRestartDNSService();
  }

  async refreshUnboundHealthState() {
    if (!this.isFeatureActive()) {
      this.resetHealthState();
      await this.emitHealthState({
        healthy: true,
        enabled: false,
        bypassActive: false,
        reason: 'feature_disabled',
        target: ''
      });
      await this.syncDnsmasqUpstreamConfig();
      return;
    }

    const probeResult = await this.probeUnboundHealth();
    const stableHealthy = this.updateStableHealth(probeResult.healthy);
    const killSwitchEnabled = await this.getKillSwitchEnabled();
    const bypassActive = !stableHealthy && !killSwitchEnabled;
    this.healthState.healthy = stableHealthy;
    this.healthState.bypassActive = bypassActive;
    this.healthState.lastError = stableHealthy ? null : probeResult.error;
    this.healthState.lastCheckedAt = Date.now();

    await this.emitHealthState({
      healthy: stableHealthy,
      enabled: true,
      bypassActive,
      reason: stableHealthy ? 'ok' : (probeResult.error || 'unbound_unhealthy'),
      target: probeResult.server || unbound.getLocalServer()
    });

    await this.syncDnsmasqUpstreamConfig();
  }

  async checkUnboundHealth() {
    await this.applyUnboundSync.exec(false, false, true);
  }

  async applyDnsmasqPolicyBindings() {
    await this.applySystemUnbound();

    for (const macAddress in this.macAddressSettings) {
      await this.applyDeviceUnbound(macAddress);
    }

    for (const tagUid in this.tagSettings) {
      const tagExists = await TagManager.tagUidExists(tagUid);
      if (!tagExists)
        this.tagSettings[tagUid] = 0;
      await this.applyTagUnbound(tagUid);
      if (!tagExists)
        delete this.tagSettings[tagUid];
    }

    for (const uuid in this.networkSettings) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile)
        delete this.networkSettings[uuid];
      else
        await this.applyNetworkUnbound(uuid);
    }

    for (const guid in this.identitySettings) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (!identity)
        delete this.identitySettings[guid];
      else
        await this.applyIdentityUnbound(guid);
    }
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying Unbound policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applySystemUnbound();
      } else {
        if (!host)
          return;
        switch (host.constructor.name) {
          case "Tag": {
            const tagUid = host.o && host.o.uid;
            if (tagUid) {
              if (policy && policy.state === true)
                this.tagSettings[tagUid] = 1;
              if (policy && policy.state === false)
                this.tagSettings[tagUid] = 0;
              if (policy && policy.state === null)
                this.tagSettings[tagUid] = -1;
              await this.applyTagUnbound(tagUid);
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
              await this.applyNetworkUnbound(uuid);
            }
            break;
          }
          case "Host": {
            const macAddress = host && host.o && host.o.mac;
            if (macAddress) {
              if (policy && policy.state === true)
                this.macAddressSettings[macAddress] = 1;
              if (policy && policy.state === false)
                this.macAddressSettings[macAddress] = 0;
              if (policy && policy.state === null)
                this.macAddressSettings[macAddress] = -1;
              await this.applyDeviceUnbound(macAddress);
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
                await this.applyIdentityUnbound(guid);
              }
            }
        }
      }
    } catch (err) {
      log.error("Got error when applying Unbound policy", err);
    }
  }

  async applyUnbound(reCheckConfig = false, refreshPolicy = true, refreshHealth = true) {
    log.debug("Apply unbound");
    if (refreshPolicy) {
      if (!this.isFeatureActive()) {
        await unbound.stop();
      } else {
        const result = await unbound.prepareConfigFile(reCheckConfig);
        if (result) {
          log.info("Unbound configuration file changed. Restart");
          unbound.restart();
        } else {
          await unbound.start();
        }
      }
    }

    const prevBypassActive = this.healthState.bypassActive;
    if (refreshHealth)
      await this.refreshUnboundHealthState();
    else
      await this.syncDnsmasqUpstreamConfig();

    const bypassChanged = this.healthState.bypassActive !== prevBypassActive;
    if (refreshPolicy || bypassChanged)
      await this.applyDnsmasqPolicyBindings();
  }

  async applySystemUnbound() {
    if (this.systemSwitch && this.shouldRouteFeatureDns()) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async applyTagUnbound(tagUid) {
    if (this.tagSettings[tagUid] == 1)
      return this.shouldRouteFeatureDns() ? this.perTagStart(tagUid) : this.perTagStop(tagUid);
    if (this.tagSettings[tagUid] == -1)
      return this.perTagStop(tagUid);
    return this.perTagReset(tagUid);
  }

  async applyNetworkUnbound(uuid) {
    if (this.networkSettings[uuid] == 1)
      return this.shouldRouteFeatureDns() ? this.perNetworkStart(uuid) : this.perNetworkStop(uuid);
    if (this.networkSettings[uuid] == -1)
      return this.perNetworkStop(uuid);
    return this.perNetworkReset(uuid);
  }

  async applyDeviceUnbound(macAddress) {
    if (this.macAddressSettings[macAddress] == 1)
      return this.shouldRouteFeatureDns() ? this.perDeviceStart(macAddress) : this.perDeviceStop(macAddress);
    if (this.macAddressSettings[macAddress] == -1)
      return this.perDeviceStop(macAddress);
    return this.perDeviceReset(macAddress);
  }

  async applyIdentityUnbound(guid) {
    if (this.identitySettings[guid] == 1)
      return this.shouldRouteFeatureDns() ? this.perIdentityStart(guid) : this.perIdentityStop(guid);
    if (this.identitySettings[guid] == -1)
      return this.perIdentityStop(guid);
    return this.perIdentityReset(guid);
  }

  async systemStart() {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${featureName}\n`;
    await dnsmasq.writeConfig(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async systemStop() {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\n`;
    await dnsmasq.writeConfig(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStart(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\n`;
    await dnsmasq.writeConfig(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStop(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\n`; // match negative tag
    await dnsmasq.writeConfig(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagReset(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
    await fs.unlinkAsync(configFile).catch((err) => { });
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
    await dnsmasq.writeConfig(configFile, dnsmasqEntry);
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
    await dnsmasq.writeConfig(configFile, dnsmasqEntry);
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
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStart(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${featureName}\n`;
    await dnsmasq.writeConfig(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStop(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${featureName}\n`;
    await dnsmasq.writeConfig(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceReset(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async perIdentityStart(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${featureName}\n`;
      await dnsmasq.writeConfig(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityStop(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${featureName}\n`;
      await dnsmasq.writeConfig(configFile, dnsmasqEntry);
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
    await super.globalOn();
    this.featureSwitch = true;
    await this.applyUnboundSync.exec(true, true, true);
  }

  async globalOff() {
    await super.globalOff();
    this.featureSwitch = false;
    this.resetHealthState();
    await this.applyUnboundSync.exec(true, true, true);
  }
}

module.exports = UnboundPlugin;
