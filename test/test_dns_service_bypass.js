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

function makeFsMock(unlinkCalls, writeFileCalls) {
  return {
    unlink(path, cb) {
      unlinkCalls.push(path);
      cb(null);
    },
    writeFile(path, content, cb) {
      writeFileCalls.push({ path, content });
      cb(null);
    }
  };
}

function makeBaseSensor() {
  return class {
    constructor(config) {
      this.config = config || {};
    }
    async globalOn() {}
    async globalOff() {}
  };
}

describe('DNS service bypass behavior', () => {
  it('should bypass DoH in dnsmasq when unhealthy and killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const fsMock = makeFsMock(unlinkCalls, []);

    const DNSCryptPlugin = proxyquire('../sensor/DNSCryptPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {
        probeLocalServer: async () => ({ healthy: false, error: 'down', server: '127.0.0.1#8854' })
      },
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../extension/dnscrypt/dnscrypt': {
        getSettings: async () => ({ killSwitch: false }),
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
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new DNSCryptPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.healthState = { healthy: false, bypassActive: true, failCount: 3, recoverCount: 0 };

    await plugin.syncDnsmasqUpstreamConfig();

    expect(writeCalls).to.have.lengthOf(0);
    expect(unlinkCalls[0]).to.equal('/tmp/firewalla/dnsmasq/doh.conf');
  });

  it('should downgrade active DoH policy bindings to negative tags during bypass', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const DNSCryptPlugin = proxyquire('../sensor/DNSCryptPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => ({}) },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {
        probeLocalServer: async () => ({ healthy: false, error: 'down', server: '127.0.0.1#8854' })
      },
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../extension/dnscrypt/dnscrypt': {
        getSettings: async () => ({ killSwitch: false }),
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
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new DNSCryptPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.identitySettings = {};
    plugin.healthCheckFailThreshold = 3;
    plugin.healthCheckRecoverThreshold = 1;
    plugin.healthState = { healthy: true, bypassActive: false, failCount: 2, recoverCount: 0 };

    await plugin.applyDoH(false, false, true);

    expect(unlinkCalls[0]).to.equal('/tmp/firewalla/dnsmasq/doh.conf');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$!doh\n');
    expect(writeCalls.map(call => call.content)).to.include('group-tag=@kids$!doh\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$!doh\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%00:00:00:00:00:00$!doh\n');
  });

  it('should restore active DoH policy bindings when bypass recovers', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const DNSCryptPlugin = proxyquire('../sensor/DNSCryptPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => ({}) },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {
        probeLocalServer: async () => ({ healthy: true, server: '127.0.0.1#8854', addresses: ['1.1.1.1'] })
      },
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../extension/dnscrypt/dnscrypt': {
        getSettings: async () => ({ killSwitch: false }),
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
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new DNSCryptPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.identitySettings = {};
    plugin.healthCheckFailThreshold = 3;
    plugin.healthCheckRecoverThreshold = 1;
    plugin.healthState = { healthy: false, bypassActive: true, failCount: 3, recoverCount: 0 };

    await plugin.applyDoH(false, false, true);

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls.map(call => call.content)).to.include('server=127.0.0.1#8854$doh$*wan');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$doh\n');
    expect(writeCalls.map(call => call.content)).to.include('group-tag=@kids$doh\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$doh\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%00:00:00:00:00:00$doh\n');
  });

  it('should keep DoH dnsmasq upstream when healthy even if killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const fsMock = makeFsMock(unlinkCalls, []);

    const DNSCryptPlugin = proxyquire('../sensor/DNSCryptPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../extension/dnscrypt/dnscrypt': {
        getSettings: async () => ({ killSwitch: false }),
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
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new DNSCryptPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.healthState = { healthy: true, bypassActive: false, failCount: 0, recoverCount: 1 };

    await plugin.syncDnsmasqUpstreamConfig();

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls).to.have.lengthOf(1);
    expect(writeCalls[0].path).to.equal('/tmp/firewalla/dnsmasq/doh.conf');
    expect(writeCalls[0].content).to.include('127.0.0.1#8854');
  });

  it('should bypass Unbound in dnsmasq when unhealthy and killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const fsMock = makeFsMock(unlinkCalls, []);

    const UnboundPlugin = proxyquire('../sensor/UnboundPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {
        probeServers: async () => ([{ server: '1.1.1.1', healthy: false, error: 'down' }]),
        summarizeProbeResults: () => ({
          healthy: false,
          firstHealthy: null,
          firstError: { error: 'down' },
          error: 'down'
        })
      },
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../extension/unbound/unbound': {
        getConfig: async () => ({ killSwitch: false }),
        getLocalServer: () => '127.0.0.1#8953',
        getLocalPort: () => 8953,
        stop: async () => {},
        start: async () => {},
        restart: async () => {},
        prepareConfigFile: async () => false,
        reset: async () => {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new UnboundPlugin({});
    plugin.featureSwitch = true;
    plugin.healthState = { healthy: false, bypassActive: true, failCount: 3, recoverCount: 0 };

    await plugin.syncDnsmasqUpstreamConfig();

    expect(writeCalls).to.have.lengthOf(0);
    expect(unlinkCalls[0]).to.equal('/tmp/firewalla/dnsmasq/unbound.conf');
  });

  it('should downgrade active Unbound policy bindings to negative tags during bypass', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const fsMock = makeFsMock(unlinkCalls, []);

    const UnboundPlugin = proxyquire('../sensor/UnboundPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => ({}) },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': { probeLocalServer: async () => ({ healthy: false, error: 'down', server: '127.0.0.1#8953' }) },
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../extension/unbound/unbound': {
        getConfig: async () => ({ killSwitch: false }),
        getLocalServer: () => '127.0.0.1#8953',
        getLocalPort: () => 8953,
        stop: async () => {},
        start: async () => {},
        restart: async () => {},
        prepareConfigFile: async () => false,
        reset: async () => {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new UnboundPlugin({});
    plugin.featureSwitch = true;
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.identitySettings = {};
    plugin.healthCheckFailThreshold = 3;
    plugin.healthCheckRecoverThreshold = 1;
    plugin.healthState = { healthy: true, bypassActive: false, failCount: 2, recoverCount: 0 };

    await plugin.applyUnbound(false, false, true);

    expect(unlinkCalls[0]).to.equal('/tmp/firewalla/dnsmasq/unbound.conf');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$!unbound\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%00:00:00:00:00:00$!unbound\n');
    expect(writeCalls.map(call => call.content)).to.include('group-tag=@kids$!unbound\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$!unbound\n');
  });

  it('should restore active Unbound policy bindings when bypass recovers', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const fsMock = makeFsMock(unlinkCalls, []);

    const UnboundPlugin = proxyquire('../sensor/UnboundPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla' },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => ({}) },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': { probeLocalServer: async () => ({ healthy: true, server: '127.0.0.1#8953', addresses: ['1.1.1.1'] }) },
      '../event/EventRequestApi.js': { addStateEvent: async () => {} },
      '../extension/unbound/unbound': {
        getConfig: async () => ({ killSwitch: false }),
        getLocalServer: () => '127.0.0.1#8953',
        getLocalPort: () => 8953,
        stop: async () => {},
        start: async () => {},
        restart: async () => {},
        prepareConfigFile: async () => false,
        reset: async () => {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' }
    });

    const plugin = new UnboundPlugin({});
    plugin.featureSwitch = true;
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.identitySettings = {};
    plugin.healthCheckFailThreshold = 3;
    plugin.healthCheckRecoverThreshold = 1;
    plugin.healthState = { healthy: false, bypassActive: true, failCount: 3, recoverCount: 0 };

    await plugin.applyUnbound(false, false, true);

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls.map(call => call.content)).to.include('server=127.0.0.1#8953$unbound$*wan');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$unbound\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%00:00:00:00:00:00$unbound\n');
    expect(writeCalls.map(call => call.content)).to.include('group-tag=@kids$unbound\n');
    expect(writeCalls.map(call => call.content)).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$unbound\n');
  });

  it('should select a healthy Family Protect server when killSwitch is disabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      '../util/redis_manager.js': { getRedisClient: () => ({ getAsync: async () => null, setAsync: async () => {}, unlinkAsync: async () => {} }) },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} }
    });

    const plugin = new FamilyProtectPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = true;
    plugin.macAddressSettings = {};
    plugin.networkSettings = {};
    plugin.tagSettings = {};
    plugin.identitySettings = {};
    plugin.healthState = {
      healthy: true,
      bypassActive: false,
      failCount: 0,
      recoverCount: 1,
      selectedServer: '9.9.9.9'
    };
    plugin.getKillSwitchEnabled = async () => false;
    plugin.getEffectiveFamilyServers = async () => ['1.1.1.1', '9.9.9.9'];
    plugin.applySystemFamilyProtect = async () => {};

    await plugin.applyFamilyProtect(true, false);

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls).to.have.lengthOf(1);
    expect(writeCalls[0].path).to.equal('/tmp/firewalla/dnsmasq/family_protect.conf');
    expect(writeCalls[0].content).to.include('9.9.9.9');
  });

  it('should select a healthy Family Protect server when killSwitch is enabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      '../util/redis_manager.js': { getRedisClient: () => ({ getAsync: async () => null, setAsync: async () => {}, unlinkAsync: async () => {} }) },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} }
    });

    const plugin = new FamilyProtectPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = true;
    plugin.macAddressSettings = {};
    plugin.networkSettings = {};
    plugin.tagSettings = {};
    plugin.identitySettings = {};
    plugin.healthState = {
      healthy: true,
      bypassActive: false,
      failCount: 0,
      recoverCount: 1,
      selectedServer: '9.9.9.9'
    };
    plugin.getKillSwitchEnabled = async () => true;
    plugin.getEffectiveFamilyServers = async () => ['1.1.1.1', '9.9.9.9'];
    plugin.applySystemFamilyProtect = async () => {};

    await plugin.applyFamilyProtect(true, false);

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls).to.have.lengthOf(1);
    expect(writeCalls[0].path).to.equal('/tmp/firewalla/dnsmasq/family_protect.conf');
    expect(writeCalls[0].content).to.include('9.9.9.9');
  });

  it('should keep Family Protect upstream when unhealthy and killSwitch is enabled', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      '../util/redis_manager.js': { getRedisClient: () => ({ getAsync: async () => null, setAsync: async () => {}, unlinkAsync: async () => {} }) },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} }
    });

    const plugin = new FamilyProtectPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = false;
    plugin.macAddressSettings = {};
    plugin.networkSettings = {};
    plugin.tagSettings = {};
    plugin.identitySettings = {};
    plugin.healthState = {
      healthy: false,
      bypassActive: false,
      failCount: 3,
      recoverCount: 0,
      selectedServer: null
    };
    plugin.getKillSwitchEnabled = async () => true;
    plugin.getEffectiveFamilyServers = async () => ['1.1.1.1'];
    plugin.applySystemFamilyProtect = async () => {};

    await plugin.applyFamilyProtect(true, false);

    expect(unlinkCalls).to.have.lengthOf(0);
    expect(writeCalls).to.have.lengthOf(1);
    expect(writeCalls[0].path).to.equal('/tmp/firewalla/dnsmasq/family_protect.conf');
    expect(writeCalls[0].content).to.include('1.1.1.1');
  });

  it('should bypass Family Protect completely when unhealthy and no healthy server is available', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      '../util/redis_manager.js': { getRedisClient: () => ({ getAsync: async () => null, setAsync: async () => {}, unlinkAsync: async () => {} }) },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} }
    });

    const plugin = new FamilyProtectPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = false;
    plugin.macAddressSettings = {};
    plugin.networkSettings = {};
    plugin.tagSettings = {};
    plugin.identitySettings = {};
    plugin.healthState = {
      healthy: false,
      bypassActive: true,
      failCount: 3,
      recoverCount: 0,
      selectedServer: null
    };
    plugin.getKillSwitchEnabled = async () => false;
    plugin.getEffectiveFamilyServers = async () => ['1.1.1.1'];
    plugin.applySystemFamilyProtect = async () => {};

    await plugin.applyFamilyProtect(true, false);

    expect(writeCalls).to.have.lengthOf(0);
    expect(unlinkCalls[0]).to.equal('/tmp/firewalla/dnsmasq/family_protect.conf');
  });

  it('should downgrade active Family Protect policy bindings to negative tags during bypass', async () => {
    const unlinkCalls = [];
    const writeCalls = [];
    const writeFileCalls = [];
    const fsMock = makeFsMock(unlinkCalls, writeFileCalls);

    const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => ({}) },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      '../util/redis_manager.js': { getRedisClient: () => ({ getAsync: async () => null, setAsync: async () => {}, unlinkAsync: async () => {} }) },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      fs: fsMock,
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig(path, content) { writeCalls.push({ path, content }); }
        scheduleRestartDNSService() {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} }
    });

    const plugin = new FamilyProtectPlugin({});
    plugin.adminSystemSwitch = true;
    plugin.systemSwitch = true;
    plugin.networkSettings = { lan: 1 };
    plugin.tagSettings = { kids: 1 };
    plugin.macAddressSettings = { 'aa:bb:cc:dd:ee:ff': 1 };
    plugin.identitySettings = {};
    plugin.healthState = {
      healthy: false,
      bypassActive: true,
      failCount: 3,
      recoverCount: 0,
      selectedServer: null
    };
    plugin.getKillSwitchEnabled = async () => false;
    plugin.getEffectiveFamilyServers = async () => ['1.1.1.1'];

    await plugin.applyFamilyProtect(true, false);

    expect(writeFileCalls.map(call => call.content)).to.include('mac-address-tag=%FF:FF:FF:FF:FF:FF$!family_protect\n');
    expect(writeFileCalls.map(call => call.content)).to.include('mac-address-tag=%00:00:00:00:00:00$!family_protect\n');
    expect(writeFileCalls.map(call => call.content)).to.include('group-tag=@kids$!family_protect\n');
    expect(writeFileCalls.map(call => call.content)).to.include('mac-address-tag=%AA:BB:CC:DD:EE:FF$!family_protect\n');
  });
});
