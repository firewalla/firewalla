/*    Copyright 2022-2025 Firewalla Inc.
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

const log = require('../../net2/logger.js')(__filename);

const { Sensor } = require('../Sensor.js');

const NetworkProfileManager = require('../../net2/NetworkProfileManager.js');
const NetworkProfile = require('../../net2/NetworkProfile.js');
const TagManager = require('../../net2/TagManager.js');
const IdentityManager = require('../../net2/IdentityManager.js');
const Constants = require('../../net2/Constants.js');
const fc = require('../../net2/config.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const extensionManager = require('../ExtensionManager.js');

// Base class for DNS upstream service plugins (DoH, Unbound, FamilyProtect).
//
// Provides routing-state initialisation, per-scope dnsmasq config writes,
// and policy-binding orchestration. Health-check awareness is NOT included —
// shouldRouteFeatureDns() defaults to isFeatureActive() and is overridden by
// HealthCheckMixin when composed on top:
//   class Plugin extends HealthCheckMixin(DnsServicePluginBase)
//
//
class DnsServicePluginBase extends Sensor {

  _init(featureName, dnsmasqConfigFolder, extensionKey) {
    this._initServiceState(featureName, dnsmasqConfigFolder);
    extensionManager.registerExtension(extensionKey || featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.globalOn,
      stop: this.globalOff,
    });
    this.hookFeature(featureName);
  }

  async _clearPolicyState() {
    await fc.disableDynamicFeature(this.featureName);
    for (const tag in this.tagSettings) this.tagSettings[tag] = 0;
    for (const uuid in this.networkSettings) this.networkSettings[uuid] = 0;
    for (const mac in this.macAddressSettings) this.macAddressSettings[mac] = 0;
    for (const guid in this.identitySettings) this.identitySettings[guid] = 0;
  }

  async _resetState() {
    await this._clearPolicyState();
  }

  // ── state initialisation ──────────────────────────────────────────────────

  _initServiceState(featureName, dnsmasqConfigFolder) {
    this.featureName         = featureName;
    this.dnsmasqConfigFolder = dnsmasqConfigFolder;
    this.systemSwitch        = false;
    this.featureSwitch       = false;
    this.networkSettings     = {};
    this.tagSettings         = {};
    this.macAddressSettings  = {};
    this.identitySettings    = {};
  }

  // ── routing decision ──────────────────────────────────────────────────────

  isFeatureActive() {
    return this.featureSwitch === true && fc.isFeatureOn(this.featureName);
  }

  // Default: route whenever the feature is active.
  shouldRouteFeatureDns() {
    return this.isFeatureActive();
  }

  // ── upstream config ───────────────────────────────────────────────────────

  async syncDnsmasqUpstreamConfig(server) {
    const configFilePath = `${this.dnsmasqConfigFolder}/${this.featureName}.conf`;
    if (server) {
      await dnsmasq.writeConfig(configFilePath, `server=${server}$${this.featureName}$*${Constants.DNS_DEFAULT_WAN_TAG}`);
    } else {
      await this._deleteConfig(configFilePath);
    }
    dnsmasq.scheduleRestartDNSService();
  }

  // ── policy bindings ───────────────────────────────────────────────────────

  async applyDnsmasqPolicyBindings() {
    await this.applySystemPolicy();

    for (const macAddress in this.macAddressSettings) {
      await this.applyDevicePolicy(macAddress);
    }

    for (const tagUid in this.tagSettings) {
      const tagExists = await TagManager.tagUidExists(tagUid);
      if (!tagExists) this.tagSettings[tagUid] = 0;
      await this.applyTagPolicy(tagUid);
      if (!tagExists) delete this.tagSettings[tagUid];
    }

    for (const uuid in this.networkSettings) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile) delete this.networkSettings[uuid];
      else await this.applyNetworkPolicy(uuid);
    }

    for (const guid in this.identitySettings) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (!identity) delete this.identitySettings[guid];
      else await this.applyIdentityPolicy(guid);
    }
  }

  // enable: true = write positive tag, false = write negative tag (!), null = delete (reset)
  async _applyScopeConfig(file, tagExpr, enable) {
    if (enable === null) await this._deleteConfig(file);
    else await this._writeConfig(file, `${tagExpr}$${enable ? '' : '!'}${this.featureName}\n`);
    dnsmasq.scheduleRestartDNSService();
  }

  _applySystemConfig(enable) {
    return this._applyScopeConfig(
      `${this.dnsmasqConfigFolder}/${this.featureName}_system.conf`,
      `mac-address-tag=%FF:FF:FF:FF:FF:FF`, enable
    );
  }

  _applyTagConfig(tagUid, enable) {
    return this._applyScopeConfig(
      `${this.dnsmasqConfigFolder}/tag_${tagUid}_${this.featureName}.conf`,
      `group-tag=@${tagUid}`, enable
    );
  }

  _applyNetworkConfig(uuid, enable) {
    const np = NetworkProfileManager.getNetworkProfile(uuid);
    if (!np) { log.warn(`Network profile not found: ${uuid}`); return; }
    return this._applyScopeConfig(
      `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${this.featureName}_${uuid}.conf`,
      `mac-address-tag=%00:00:00:00:00:00`, enable
    );
  }

  _applyDeviceConfig(macAddress, enable) {
    return this._applyScopeConfig(
      `${this.dnsmasqConfigFolder}/${this.featureName}_${macAddress}.conf`,
      `mac-address-tag=%${macAddress.toUpperCase()}`, enable
    );
  }

  async _applyIdentityConfig(guid, enable) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (!identity) return;
    const uid = identity.getUniqueId();
    return this._applyScopeConfig(
      `${this.dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${this.featureName}.conf`,
      `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}`, enable
    );
  }

  async applySystemPolicy() {
    return this._applySystemConfig(this.systemSwitch && this.shouldRouteFeatureDns());
  }

  async applyTagPolicy(tagUid) {
    const s = this.tagSettings[tagUid];
    return this._applyTagConfig(tagUid, s == 1 ? this.shouldRouteFeatureDns() : s == -1 ? false : null);
  }

  async applyNetworkPolicy(uuid) {
    const s = this.networkSettings[uuid];
    return this._applyNetworkConfig(uuid, s == 1 ? this.shouldRouteFeatureDns() : s == -1 ? false : null);
  }

  async applyDevicePolicy(macAddress) {
    const s = this.macAddressSettings[macAddress];
    return this._applyDeviceConfig(macAddress, s == 1 ? this.shouldRouteFeatureDns() : s == -1 ? false : null);
  }

  async applyIdentityPolicy(guid) {
    const s = this.identitySettings[guid];
    return this._applyIdentityConfig(guid, s == 1 ? this.shouldRouteFeatureDns() : s == -1 ? false : null);
  }

  // ── dnsmasq config writes ─────────────────────────────────────────────────

  async _writeConfig(file, entry) {
    await dnsmasq.writeConfig(file, entry);
  }

  async _deleteConfig(file) {
    await fs.unlinkAsync(file).catch(() => {});
  }

  async applyPolicy(host, ip, policy) { log.error('applyPolicy() not implemented by subclass!'); }

  async globalOn() {
    this.featureSwitch = true;
    await this._runApply();
  }

  async globalOff() {
    this.featureSwitch = false;
    await this._runApply();
  }

  // Subclass hook: trigger this plugin's apply scheduler (e.g. applyDoHSync.exec(...)).
  async _runApply() { log.error(`_runApply() not implemented for ${this.featureName}`); }
}

module.exports = DnsServicePluginBase;
