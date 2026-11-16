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
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');
const IdentityManager = require('../net2/IdentityManager.js');
const exec = require('child-process-promise').exec;
const scheduler = require('../util/scheduler');
const dnsHealth = require('../util/DNSUpstreamHealthCheck.js');

const featureName = "doh";
const fc = require('../net2/config.js');
const dc = require('../extension/dnscrypt/dnscrypt');
const Constants = require('../net2/Constants.js');

class DNSCryptPlugin extends HealthCheckMixin(DnsServicePluginBase) {

  get _defaultHealthCheckTimeout() { return 5; }

  async run() {
    this.refreshInterval = (this.config.refreshInterval || 24 * 60) * 60 * 1000;
    this._init(featureName, `${f.getUserConfigFolder()}/dnsmasq`);
    this.applyDoHSync = new scheduler.UpdateJob(this.applyDoH.bind(this), 0);

    await exec(`mkdir -p ${this.dnsmasqConfigFolder}`);

    sem.on('DOH_REFRESH', () => {
      void this.applyDoHSync.exec(true);
    });

    sem.on('DOH_RESET', async () => {
      try {
        await this._resetState();
        await dc.resetSettings();
        await this.applyDoHSync.exec(true);
      } catch(err) {
        log.error('Error reseting DoH', err);
      }
    });
  }

  async job() {
    await this.applyDoHSync.exec(true);
  }

  async apiRun() {
    extensionManager.onSet("dohConfig", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin:{
        servers: await dc.getServers(),
        killSwitch: (await dc.getSettings()).killSwitch
      }})} catch(err) {};

      if (data) {
        if (Array.isArray(data.servers)) {
          await dc.setServers(data.servers, false);
        }
        if (Object.prototype.hasOwnProperty.call(data, 'killSwitch') && typeof data.killSwitch === 'boolean') {
          await dc.updateSettings({ killSwitch: data.killSwitch });
        }
        sem.sendEventToFireMain({ type: 'DOH_REFRESH' });
      }
    });

    extensionManager.onSet("customizedDohServers", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin:{customizedServers: await dc.getCustomizedServers()}})} catch(err) {};
      if (data && Array.isArray(data.servers)) {
        await dc.setServers(data.servers, true);
        sem.sendEventToFireMain({ type: 'DOH_REFRESH' });
      }
    });

    extensionManager.onGet("dohConfig", async (msg, data) => {
      const selectedServers = await dc.getServers();
      const customizedServers = await dc.getCustomizedServers();
      const allServers = await dc.getAllServerNames();
      const settings = await dc.getSettings();
      return { selectedServers, allServers, customizedServers, killSwitch: settings.killSwitch };
    });

    extensionManager.onCmd("dohReset", async (msg, data) => {
      try {await extensionManager._precedeRecord(msg.id, {origin: {
        servers: await dc.getServers(), customizedServers: await dc.getCustomizedServers(), allServers: await dc.getAllServerNames(),
        killSwitch: (await dc.getSettings()).killSwitch,
        enabled: fc.isFeatureOn(featureName)}})
      } catch(err) {};
      sem.sendEventToFireMain({ type: 'DOH_RESET' });
    });
  }

  async getKillSwitchEnabled() {
    const settings = await dc.getSettings();
    return settings.killSwitch !== false;
  }

  _getUpstreamServer() {
    return dc.getLocalServer();
  }

  async probeHealth() {
    const result = await dnsHealth.probeLocalServer(Constants.LOCALHOST, dc.getLocalPort(), {
      domains: this.getHealthCheckDomains(),
      timeout: this.healthCheckTimeout,
      tries: this.healthCheckTries
    });
    return { healthy: result.healthy, error: result.error, target: result.server || dc.getLocalServer() };
  }

  async applyDoH(reCheckConfig = false) {
    if (!fc.isFeatureOn(featureName)) {
      await dc.stop();
    } else {
      const result = await dc.prepareConfig({}, reCheckConfig);
      if (result) { dc.restart(); } else { await dc.start(); }
    }
    await this.syncDnsmasqUpstreamConfig();
    await this.applyDnsmasqPolicyBindings();
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying DoH policy:", ip, policy);
    try {
      if (ip === Constants.INADDR_ANY) {
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
      log.error("Got error when applying DoH policy", err);
    }
  }

  async _runApply() {
    await this.applyDoHSync.exec(true);
  }
}

module.exports = DNSCryptPlugin;
