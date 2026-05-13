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

function makeFsMock() {
  return {
    unlink(path, cb) {
      cb(null);
    },
    writeFile(path, content, cb) {
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

describe('DNS service config resilience', () => {
  it('should emit a distinct disabled DNS service state value', async () => {
    const stateEvents = [];
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
      fs: makeFsMock(),
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig() {}
        scheduleRestartDNSService() {}
      },
      'child-process-promise': { exec: async () => ({}) },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': {
        addStateEvent: async (stateType, stateKey, stateValue, labels) => {
          stateEvents.push({ stateType, stateKey, stateValue, labels });
        }
      },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      '../extension/dnscrypt/dnscrypt': {
        getSettings: async () => ({ killSwitch: true }),
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
    await plugin.emitHealthState({
      healthy: true,
      enabled: false,
      bypassActive: false,
      reason: 'feature_disabled',
      target: ''
    });

    expect(stateEvents).to.have.lengthOf(1);
    expect(stateEvents[0].stateValue).to.equal(2);
    expect(stateEvents[0].labels.error_value).to.equal(1);
  });

  it('should reload Family Protect servers from persisted config when refresh config omits servers', async () => {
    const FamilyProtectPlugin = proxyquire('../sensor/FamilyProtectPlugin.js', {
      '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      './Sensor.js': { Sensor: makeBaseSensor() },
      './ExtensionManager.js': { registerExtension: () => {}, onSet: () => {}, onGet: () => {}, onCmd: () => {}, _precedeRecord: async () => {} },
      '../net2/NetworkProfileManager.js': { getNetworkProfile: () => null },
      '../net2/NetworkProfile.js': { getDnsmasqConfigDirectory: () => '/tmp/dns' },
      '../net2/TagManager.js': { tagUidExists: async () => true },
      '../net2/IdentityManager.js': { isIdentity: () => false, getGUID: () => null, getIdentityByGUID: () => null },
      '../util/redis_manager.js': {
        getRedisClient: () => ({
          getAsync: async () => JSON.stringify({ killSwitch: false, servers: ['9.9.9.9'] }),
          setAsync: async () => {},
          unlinkAsync: async () => {}
        })
      },
      '../sensor/SensorEventManager.js': { getInstance: () => ({ on: () => {}, sendEventToFireMain: () => {} }) },
      '../net2/Firewalla.js': { getUserConfigFolder: () => '/tmp/firewalla', getBoneInfoAsync: async () => null },
      '../net2/config.js': { isFeatureOn: () => true, disableDynamicFeature: async () => {} },
      fs: makeFsMock(),
      '../extension/dnsmasq/dnsmasq.js': class {
        async writeConfig() {}
        scheduleRestartDNSService() {}
      },
      '../net2/Constants.js': { DNS_DEFAULT_WAN_TAG: 'wan', STATE_EVENT_DNS_SERVICE: 'dns_service' },
      '../util/scheduler': { UpdateJob: class { constructor(fn) { this.fn = fn; } async exec(...args) { return this.fn(...args); } } },
      '../util/DNSUpstreamHealthCheck.js': {},
      '../event/EventRequestApi.js': { addStateEvent: async () => {} }
    });

    const plugin = new FamilyProtectPlugin({});

    plugin.applyFamilyConfig({ servers: ['1.1.1.1'] });
    expect(await plugin.getEffectiveFamilyServers()).to.deep.equal(['1.1.1.1']);

    plugin.applyFamilyConfig({ killSwitch: false });
    expect(await plugin.getEffectiveFamilyServers()).to.deep.equal(['9.9.9.9']);
  });

  it('should ignore malformed Unbound redis entries and keep defaults', async () => {
    const unbound = proxyquire('../extension/unbound/unbound.js', {
      '../../net2/logger': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
      '../../util/redis_manager': {
        getRedisClient: () => ({
          hgetallAsync: async () => ({
            upstream: '"tcp"',
            dnssec: 'not-json',
            killSwitch: 'false'
          })
        })
      },
      'child-process-promise': { exec: async () => ({}) },
      '../../net2/Firewalla.js': { getFirewallaHome: () => '/tmp/firewalla', getRuntimeInfoFolder: () => '/tmp/runtime' },
      '../../util/util.js': { fileRemove: async () => {} },
      mustache: { render: () => '' },
      '../vpnclient/VPNClient': { getRouteMarkKey: () => 'mark' },
      '../../net2/VirtWanGroup.js': { getRouteMarkKey: () => 'mark' },
      '../../net2/Constants.js': { ACL_VIRT_WAN_GROUP_PREFIX: 'VWG:' }
    });

    const config = await unbound.getConfig();
    expect(config).to.deep.include({
      upstream: 'tcp',
      dnssec: true,
      killSwitch: false
    });
  });
});
