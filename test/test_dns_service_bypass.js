/*    Copyright 2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();

const DNSMASQ_DIR = '/tmp/firewalla/dnsmasq';
const logger = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
const sem = { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) };
const extensionManager = { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} };
const constants = { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' };

function makeBaseSensor() {
  return class {
    constructor(config) {
      this.config = config || {};
    }
    hookFeature() {}
    async globalOn() {}
    async globalOff() {}
  };
}

function makeFsMock(unlinkCalls = []) {
  return {
    unlink(path, cb) {
      unlinkCalls.push(path);
      cb(null);
    }
  };
}

function loadBase({ unlinkCalls = [], writeCalls = [], featureOn = true, networkExists = true } = {}) {
  return proxyquire('../sensor/base/DnsServicePluginBase.js', {
    '../Sensor.js': { Sensor: makeBaseSensor() },
    '../ExtensionManager.js': extensionManager,
    '../../net2/logger.js': logger,
    '../../net2/NetworkProfileManager.js': { getNetworkProfile: () => networkExists ? {} : null },
    '../../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
    '../../net2/TagManager.js': { tagUidExists: async () => true },
    '../../net2/IdentityManager.js': { getIdentityByGUID: () => null },
    '../../net2/Constants.js': constants,
    '../../net2/config.js': { isFeatureOn: () => featureOn, disableDynamicFeature: async () => {} },
    fs: makeFsMock(unlinkCalls),
    '../../extension/dnsmasq/dnsmasq.js': class {
      async writeConfig(path, content) { writeCalls.push({ path, content }); }
      scheduleRestartDNSService() {}
    }
  });
}

function loadHealthMixin(stateEvents = []) {
  return proxyquire('../sensor/base/HealthCheckMixin.js', {
    '../../net2/logger.js': logger,
    '../../net2/Constants.js': constants,
    '../../event/EventRequestApi.js': {
      addStateEvent: async (stateType, stateKey, stateValue, labels) => {
        stateEvents.push({ stateType, stateKey, stateValue, labels });
      }
    }
  });
}

function initPlugin(plugin, featureName) {
  plugin._initServiceState(featureName, DNSMASQ_DIR);
  plugin.featureSwitch = true;
  return plugin;
}

function loadDNSCrypt({ unlinkCalls = [], writeCalls = [], probeHealthy = true, killSwitch = true, featureOn = true } = {}) {
  const DNSCryptPlugin = proxyquire('../sensor/DNSCryptPlugin.js', {
    '../net2/logger.js': logger,
    './base/DnsServicePluginBase.js': loadBase({ unlinkCalls, writeCalls, featureOn }),
    './base/HealthCheckMixin.js': loadHealthMixin(),
    './ExtensionManager.js': extensionManager,
    '../sensor/SensorEventManager.js': sem,
    '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
    '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
    'child-process-promise': { exec: async () => ({}) },
    '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
    '../util/DNSUpstreamHealthCheck.js': {
      probeLocalServer: async () => probeHealthy
        ? { healthy: true, server: '127.0.0.1#8854', addresses: ['1.1.1.1'] }
        : { healthy: false, error: 'down', server: '127.0.0.1#8854' }
    },
    '../net2/config.js': { isFeatureOn: () => featureOn, disableDynamicFeature: async () => {} },
    '../extension/dnscrypt/dnscrypt': {
      getSettings: async () => ({ killSwitch }),
      getLocalServer: () => '127.0.0.1#8854',
      getLocalPort: () => 8854,
      stop: async () => {},
      start: async () => {},
      restart: async () => {},
      prepareConfig: async () => false,
      getServers: async () => [],
      getCustomizedServers: async () => [],
      getAllServerNames: async () => [],
      setServers: async () => {},
      updateSettings: async () => {},
      resetSettings: async () => {}
    }
  });
  return initPlugin(new DNSCryptPlugin({}), 'doh');
}

function loadUnbound({ unlinkCalls = [], writeCalls = [], probeHealthy = true, killSwitch = true, featureOn = true } = {}) {
  const UnboundPlugin = proxyquire('../sensor/UnboundPlugin.js', {
    '../net2/logger.js': logger,
    './base/DnsServicePluginBase.js': loadBase({ unlinkCalls, writeCalls, featureOn }),
    './base/HealthCheckMixin.js': loadHealthMixin(),
    './ExtensionManager.js': extensionManager,
    '../sensor/SensorEventManager.js': sem,
    '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
    '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
    'child-process-promise': { exec: async () => ({}) },
    '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
    '../util/DNSUpstreamHealthCheck.js': {
      probeLocalServer: async () => probeHealthy
        ? { healthy: true, server: '127.0.0.1#8953', addresses: ['1.1.1.1'] }
        : { healthy: false, error: 'down', server: '127.0.0.1#8953' }
    },
    '../net2/config.js': { isFeatureOn: () => featureOn, disableDynamicFeature: async () => {} },
    '../extension/unbound/unbound': {
      getConfig: async () => ({ killSwitch }),
      getLocalServer: () => '127.0.0.1#8953',
      getLocalPort: () => 8953,
      stop: async () => {},
      start: async () => {},
      restart: async () => {},
      reset: async () => {},
      prepareConfigFile: async () => false,
      updateUserConfig: async () => {}
    }
  });
  return initPlugin(new UnboundPlugin({}), 'unbound');
}

function summarizeProbeResults(results) {
  const firstHealthy = results.find(result => result.healthy);
  const firstError = results.find(result => !result.healthy);
  return {
    healthy: !!firstHealthy,
    firstHealthy,
    firstError,
    error: firstError && firstError.error || null
  };
}

function loadFamily({ unlinkCalls = [], writeCalls = [], servers = ['1.1.1.3'], killSwitch = true, probeResults = null, featureOn = true } = {}) {
  const config = { killSwitch, servers };
  const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
    '../net2/logger.js': logger,
    './base/DnsServicePluginBase.js': loadBase({ unlinkCalls, writeCalls, featureOn }),
    './base/HealthCheckMixin.js': loadHealthMixin(),
    './ExtensionManager.js': extensionManager,
    '../sensor/SensorEventManager.js': sem,
    '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
    '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
    '../util/redis_manager.js': {
      getRedisClient: () => ({
        getAsync: async () => JSON.stringify(config),
        setAsync: async () => {},
        unlinkAsync: async () => {}
      })
    },
    '../net2/config.js': { isFeatureOn: () => featureOn, disableDynamicFeature: async () => {} },
    '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
    '../util/DNSUpstreamHealthCheck.js': {
      probeServers: async () => probeResults || servers.map(server => ({ server, healthy: true, addresses: ['1.1.1.1'] })),
      summarizeProbeResults
    }
  });
  const plugin = initPlugin(new FamilyProtectPlugin({}), 'family_protect');
  plugin.applyFamilyConfig(config);
  return plugin;
}

async function makeUnhealthy(plugin) {
  plugin.healthCheckFailThreshold = 3;
  plugin.healthState.failCount = 2;
  await plugin.healthCheck(true);
}

describe('DNS service bypass behavior', () => {
  it('should bypass DoH in dnsmasq when unhealthy and killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadDNSCrypt({ unlinkCalls, writeCalls, probeHealthy: false, killSwitch: false });

    await makeUnhealthy(plugin);

    expect(plugin.healthState.bypassActive).to.equal(true);
    expect(writeCalls.some(call => call.content.startsWith('server='))).to.equal(false);
    expect(unlinkCalls).to.include(`${DNSMASQ_DIR}/doh.conf`);
  });

  it('should downgrade active DoH policy bindings to negative tags during bypass', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadDNSCrypt({ unlinkCalls, writeCalls, probeHealthy: false, killSwitch: false });
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };

    await makeUnhealthy(plugin);

    const contents = writeCalls.map(call => call.content);
    expect(contents).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$!doh\n');
    expect(contents).to.include('group-tag=@kids$!doh\n');
    expect(contents).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$!doh\n');
    expect(contents).to.include('mac-address-tag=%00:00:00:00:00:00$!doh\n');
  });

  it('should restore active DoH policy bindings when bypass recovers', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadDNSCrypt({ unlinkCalls, writeCalls, probeHealthy: true, killSwitch: false });
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.healthState.healthy = false;
    plugin.healthState.bypassActive = true;

    await plugin.healthCheck(true);

    const contents = writeCalls.map(call => call.content);
    expect(unlinkCalls).to.have.lengthOf(0);
    expect(contents).to.include('server=127.0.0.1#8854$doh$*wan');
    expect(contents).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$doh\n');
    expect(contents).to.include('group-tag=@kids$doh\n');
    expect(contents).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$doh\n');
    expect(contents).to.include('mac-address-tag=%00:00:00:00:00:00$doh\n');
  });

  it('should keep DoH dnsmasq upstream when healthy even if killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadDNSCrypt({ unlinkCalls, writeCalls, probeHealthy: true, killSwitch: false });

    await plugin.healthCheck(false);

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls.map(call => call.content)).to.include('server=127.0.0.1#8854$doh$*wan');
  });

  it('should bypass Unbound in dnsmasq when unhealthy and killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadUnbound({ unlinkCalls, writeCalls, probeHealthy: false, killSwitch: false });

    await makeUnhealthy(plugin);

    expect(plugin.healthState.bypassActive).to.equal(true);
    expect(writeCalls.some(call => call.content.startsWith('server='))).to.equal(false);
    expect(unlinkCalls).to.include(`${DNSMASQ_DIR}/unbound.conf`);
  });

  it('should downgrade active Unbound policy bindings to negative tags during bypass', async () => {
    const writeCalls = [];
    const plugin = loadUnbound({ writeCalls, probeHealthy: false, killSwitch: false });
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };

    await makeUnhealthy(plugin);

    const contents = writeCalls.map(call => call.content);
    expect(contents).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$!unbound\n');
    expect(contents).to.include('group-tag=@kids$!unbound\n');
    expect(contents).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$!unbound\n');
    expect(contents).to.include('mac-address-tag=%00:00:00:00:00:00$!unbound\n');
  });

  it('should restore active Unbound policy bindings when bypass recovers', async () => {
    const writeCalls = [];
    const plugin = loadUnbound({ writeCalls, probeHealthy: true, killSwitch: false });
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.healthState.healthy = false;
    plugin.healthState.bypassActive = true;

    await plugin.healthCheck(true);

    const contents = writeCalls.map(call => call.content);
    expect(contents).to.include('server=127.0.0.1#8953$unbound$*wan');
    expect(contents).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$unbound\n');
    expect(contents).to.include('group-tag=@kids$unbound\n');
    expect(contents).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$unbound\n');
    expect(contents).to.include('mac-address-tag=%00:00:00:00:00:00$unbound\n');
  });

  it('should select a healthy Family Protect server when killSwitch is disabled', async () => {
    const writeCalls = [];
    const plugin = loadFamily({
      writeCalls,
      servers: ['127.0.0.1#9', '1.1.1.3'],
      killSwitch: false,
      probeResults: [
        { server: '127.0.0.1#9', healthy: false, error: 'down' },
        { server: '1.1.1.3', healthy: true, addresses: ['1.1.1.1'] }
      ]
    });

    await plugin.healthCheck(false);

    expect(plugin.healthState.server).to.equal('1.1.1.3');
    expect(plugin.healthState.bypassActive).to.equal(false);
    expect(writeCalls.map(call => call.content)).to.include('server=1.1.1.3$family_protect$*wan');
  });

  it('should select a healthy Family Protect server when killSwitch is enabled', async () => {
    const writeCalls = [];
    const plugin = loadFamily({
      writeCalls,
      servers: ['127.0.0.1#9', '1.1.1.3'],
      killSwitch: true,
      probeResults: [
        { server: '127.0.0.1#9', healthy: false, error: 'down' },
        { server: '1.1.1.3', healthy: true, addresses: ['1.1.1.1'] }
      ]
    });

    await plugin.healthCheck(false);

    expect(plugin.healthState.server).to.equal('1.1.1.3');
    expect(plugin.healthState.bypassActive).to.equal(false);
    expect(writeCalls.map(call => call.content)).to.include('server=1.1.1.3$family_protect$*wan');
  });

  it('should keep Family Protect upstream when unhealthy and killSwitch is enabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadFamily({
      unlinkCalls,
      writeCalls,
      servers: ['127.0.0.1#9'],
      killSwitch: true,
      probeResults: [{ server: '127.0.0.1#9', healthy: false, error: 'down' }]
    });
    plugin.healthState.failCount = 3;

    await plugin.healthCheck(false);

    expect(plugin.healthState.healthy).to.equal(false);
    expect(plugin.healthState.bypassActive).to.equal(false);
    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls.map(call => call.content)).to.include('server=127.0.0.1#9$family_protect$*wan');
  });

  it('should bypass Family Protect completely when unhealthy and no healthy server is available', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const plugin = loadFamily({
      unlinkCalls,
      writeCalls,
      servers: ['127.0.0.1#9'],
      killSwitch: false,
      probeResults: [{ server: '127.0.0.1#9', healthy: false, error: 'down' }]
    });
    plugin.healthState.failCount = 3;

    await plugin.healthCheck(false);

    expect(plugin.healthState.bypassActive).to.equal(true);
    expect(writeCalls.some(call => call.content.startsWith('server='))).to.equal(false);
    expect(unlinkCalls).to.include(`${DNSMASQ_DIR}/family_protect.conf`);
  });

  it('should downgrade active Family Protect policy bindings to negative tags during bypass', async () => {
    const writeCalls = [];
    const plugin = loadFamily({
      writeCalls,
      servers: ['127.0.0.1#9'],
      killSwitch: false,
      probeResults: [{ server: '127.0.0.1#9', healthy: false, error: 'down' }]
    });
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.healthState.failCount = 3;

    await plugin.healthCheck(true);

    const contents = writeCalls.map(call => call.content);
    expect(contents).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$!family_protect\n');
    expect(contents).to.include('group-tag=@kids$!family_protect\n');
    expect(contents).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$!family_protect\n');
    expect(contents).to.include('mac-address-tag=%00:00:00:00:00:00$!family_protect\n');
  });
});
