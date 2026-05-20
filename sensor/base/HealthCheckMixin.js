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
const Constants = require('../../net2/Constants.js');
const era = require('../../event/EventRequestApi.js');

// Health-check layer for DNS upstream service plugins.
//
// Composes on top of DnsServicePluginBase:
//   class Plugin extends HealthCheckMixin(DnsServicePluginBase)
//
// Overrides shouldRouteFeatureDns() to gate routing on health state,
// and extends _initServiceState() to initialise health fields after
// the redirect state is set up by the layer below.
//
// Plugin-Subclass must override:
//   getKillSwitchEnabled()
//   probeHealth()
//   _getUpstreamServer()
const HealthCheckMixin = (Base) => class extends Base {

  // ── default health-check config (override per plugin as needed) ───────────

  get _defaultHealthCheckTimeout() { return 3; }
  get _defaultHealthCheckTries() { return 1; }
  get _defaultHealthCheckFailThreshold() { return 3; }

  // ── state initialisation ──────────────────────────────────────────────────

  _initServiceState(featureName, dnsmasqConfigFolder) {
    super._initServiceState(featureName, dnsmasqConfigFolder);
    this.healthCheckInterval = (this.config.healthCheckInterval || 60) * 1000;
    this.healthCheckTimeout = this.config.healthCheckTimeout || this._defaultHealthCheckTimeout;
    this.healthCheckTries = this.config.healthCheckTries || this._defaultHealthCheckTries;
    this.healthCheckFailThreshold = this.config.healthCheckFailThreshold || this._defaultHealthCheckFailThreshold;
    this.healthCheckRecoverThreshold = this.config.healthCheckRecoverThreshold || 1;
    this.resetHealthState();
  }

  // ── health state ──────────────────────────────────────────────────────────

  resetHealthState() {
    this.healthState = Object.assign({}, this.healthState, {
      healthy: true,
      bypassActive: false,
      failCount: 0,
      recoverCount: 0,
      lastError: null,
      lastCheckedAt: null,
      server: null,
    });
  }

  // Overrides DnsServicePluginBase: also gates on health bypass state.
  shouldRouteFeatureDns() {
    return this.isFeatureActive() && this.healthState.bypassActive !== true;
  }

  // Implements hysteresis: returns the new stable healthy value after applying
  // fail/recover thresholds.
  updateStableHealth(nextProbeHealthy) {
    if (nextProbeHealthy) {
      this.healthState.failCount = 0;
      if (this.healthState.healthy === true) return true;
      this.healthState.recoverCount += 1;
      if (this.healthState.recoverCount >= this.healthCheckRecoverThreshold) {
        this.healthState.recoverCount = 0;
        return true;
      }
      return false;
    }

    this.healthState.recoverCount = 0;
    this.healthState.failCount += 1;
    if (this.healthState.healthy === false) return false;
    if (this.healthState.failCount >= this.healthCheckFailThreshold) return false;
    return true;
  }

  async emitHealthState({ healthy, enabled, bypassActive, reason, target }) {
    const stateValue = enabled === false ? 2 : (healthy ? 0 : 1);
    await era.addStateEvent(Constants.STATE_EVENT_DNS_SERVICE, this.featureName, stateValue, {
      service: this.featureName,
      enabled,
      killSwitch: await this.getKillSwitchEnabled(),
      bypassActive,
      reason,
      target,
      error_value: 1
    });
  }

  getHealthCheckDomains() {
    return this.config.healthCheckDomains;
  }

  async getKillSwitchEnabled() {
    log.error('getKillSwitchEnabled() not implemented by subclass!');
    return true;
  }

  // ── health-check timer lifecycle ──────────────────────────────────────────

  _startHealthCheckTask() {
    if (this.healthCheckTask) return;
    this.healthCheckTask = setInterval(() => {
      this.healthCheck().catch((err) => {
        log.error(`Failed to run ${this.featureName} health check`, err);
      });
    }, this.healthCheckInterval);
  }

  _stopHealthCheckTask() {
    if (!this.healthCheckTask) return;
    clearInterval(this.healthCheckTask);
    this.healthCheckTask = null;
  }

  async globalOn() {
    await super.globalOn();
    this._startHealthCheckTask();
  }

  async globalOff() {
    this._stopHealthCheckTask();
    await super.globalOff();
    await this.refreshHealthState();
  }

  async _resetState() {
    await super._resetState();
    this.resetHealthState();
  }

  async syncDnsmasqUpstreamConfig() {
    const server = this.isFeatureActive() && !this.healthState.bypassActive
      ? await this._getUpstreamServer() : null;
    return super.syncDnsmasqUpstreamConfig(server);
  }

  _getUpstreamServer() {
    log.error('_getUpstreamServer() not implemented by subclass!');
    return null;
  }

  async healthCheck() {
    if (!this.featureSwitch) return;
    const prevBypassActive = this.healthState.bypassActive;
    await this.refreshHealthState();
    await this.syncDnsmasqUpstreamConfig();
    if (this.healthState.bypassActive !== prevBypassActive)
      await this.applyDnsmasqPolicyBindings();
  }

  // ── unified health refresh (no syncDnsmasqUpstreamConfig; caller does it) ──

  async refreshHealthState() {
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

    const probeResult = await this.probeHealth();
    const stableHealthy = this.updateStableHealth(probeResult.healthy);
    const killSwitchEnabled = await this.getKillSwitchEnabled();
    const bypassActive = !stableHealthy && !killSwitchEnabled;
    this.healthState.healthy = stableHealthy;
    this.healthState.bypassActive = bypassActive;
    this.healthState.lastError = stableHealthy ? null : probeResult.error;
    this.healthState.lastCheckedAt = Date.now();
    this.healthState.server = probeResult.target || null;

    await this.emitHealthState({
      healthy: stableHealthy,
      enabled: true,
      bypassActive,
      reason: stableHealthy ? 'ok' : (probeResult.error || `${this.featureName}_unhealthy`),
      target: probeResult.target
    });
  }

  async probeHealth() {
    log.error('probeHealth() not implemented by subclass!');
    return { healthy: true, error: null, target: '' };
  }
};

module.exports = HealthCheckMixin;
