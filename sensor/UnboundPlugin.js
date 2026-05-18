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

const log = require('../net2/logger.js')(__filename);
const DnsServicePluginBase = require('./base/DnsServicePluginBase.js');
const HealthCheckMixin = require('./base/HealthCheckMixin.js');

const extensionManager = require('./ExtensionManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const IdentityManager = require('../net2/IdentityManager.js');
const exec = require('child-process-promise').exec;
const scheduler = require('../util/scheduler');
const unbound = require('../extension/unbound/unbound');
const dnsHealth = require('../util/DNSUpstreamHealthCheck.js');

const featureName = "unbound";

class UnboundPlugin extends HealthCheckMixin(DnsServicePluginBase) {

  get _defaultHealthCheckTimeout() { return 2; }

  async run() {
    this._init(featureName, `${f.getUserConfigFolder()}/dnsmasq`);
    this.applyUnboundSync = new scheduler.UpdateJob(this.applyUnbound.bind(this), 0);

    await exec(`mkdir -p ${this.dnsmasqConfigFolder}`);
    await exec(`mkdir -p ${f.getUserConfigFolder()}/unbound_local`);

    sem.on('UNBOUND_REFRESH', () => {
      void this.applyUnboundSync.exec(true);
    });

    sem.on('UNBOUND_RESET', async () => {
      try {
        await this._resetState();
        await unbound.reset();
        await this.applyUnboundSync.exec(true);
      } catch(err) {
        log.error('Error reseting unbound', err);
      }
    });
  }

  async apiRun() {
    extensionManager.onSet("unboundConfig", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: await unbound.getConfig()})} catch(err) {};
      if (data) {
        const sanitized = Object.assign({}, data);
        if ('killSwitch' in sanitized && typeof sanitized.killSwitch !== 'boolean')
          delete sanitized.killSwitch;
        await unbound.updateUserConfig(sanitized);
        sem.sendEventToFireMain({ type: 'UNBOUND_REFRESH' });
      }
    });

    extensionManager.onGet("unboundConfig", async (msg, data) => {
      return unbound.getConfig();
    });

    extensionManager.onCmd("unboundReset", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: {config: await unbound.getConfig(), enabled: fc.isFeatureOn(featureName)}})} catch(err) {};
      sem.sendEventToFireMain({ type: 'UNBOUND_RESET' });
    });
  }

  async getKillSwitchEnabled() {
    const config = await unbound.getConfig();
    return config.killSwitch !== false;
  }

  _getUpstreamServer() {
    return unbound.getLocalServer();
  }

  async probeHealth() {
    const result = await dnsHealth.probeLocalServer('127.0.0.1', unbound.getLocalPort(), {
      domains: this.getHealthCheckDomains(),
      timeout: this.healthCheckTimeout,
      tries: this.healthCheckTries
    });
    return { healthy: result.healthy, error: result.error, target: result.server || unbound.getLocalServer() };
  }

  async applyUnbound(reCheckConfig = false) {
    log.debug("Apply unbound");
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
    await this.syncDnsmasqUpstreamConfig();
    await this.applyDnsmasqPolicyBindings();
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying Unbound policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        this.systemSwitch = !!(policy && policy.state);
        return this.applySystemPolicy();
      }
      if (!host) return;
      switch (host.constructor.name) {
        case "Tag": {
          const tagUid = host.o && host.o.uid;
          if (tagUid) {
            if (policy && policy.state === true)  this.tagSettings[tagUid] = 1;
            if (policy && policy.state === false) this.tagSettings[tagUid] = 0;
            if (policy && policy.state === null)  this.tagSettings[tagUid] = -1;
            await this.applyTagPolicy(tagUid);
          }
          break;
        }
        case "NetworkProfile": {
          const uuid = host.o && host.o.uuid;
          if (uuid) {
            if (policy && policy.state === true)  this.networkSettings[uuid] = 1;
            if (policy && policy.state === false) this.networkSettings[uuid] = 0;
            if (policy && policy.state === null)  this.networkSettings[uuid] = -1;
            await this.applyNetworkPolicy(uuid);
          }
          break;
        }
        case "Host": {
          const macAddress = host && host.o && host.o.mac;
          if (macAddress) {
            if (policy && policy.state === true)  this.macAddressSettings[macAddress] = 1;
            if (policy && policy.state === false) this.macAddressSettings[macAddress] = 0;
            if (policy && policy.state === null)  this.macAddressSettings[macAddress] = -1;
            await this.applyDevicePolicy(macAddress);
          }
          break;
        }
        default:
          if (IdentityManager.isIdentity(host)) {
            const guid = IdentityManager.getGUID(host);
            if (guid) {
              if (policy && policy.state === true)  this.identitySettings[guid] = 1;
              if (policy && policy.state === false) this.identitySettings[guid] = 0;
              if (policy && policy.state === null)  this.identitySettings[guid] = -1;
              await this.applyIdentityPolicy(guid);
            }
          }
      }
    } catch (err) {
      log.error("Got error when applying Unbound policy", err);
    }
  }

  // global on/off
  async globalOn() {
    this.featureSwitch = true;
    await this.applyUnboundSync.exec(true);
  }

  async globalOff() {
    this.featureSwitch = false;
    this.resetHealthState();
    await this.applyUnboundSync.exec(true);
  }
}

module.exports = UnboundPlugin;
