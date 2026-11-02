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
const proxyquire = require('proxyquire').noCallThru();

const interfaces = {};
const getHandlers = {};

const InternetSpeedtestPlugin = proxyquire('../sensor/InternetSpeedtestPlugin.js', {
  '../net2/logger.js': () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  './Sensor.js': { Sensor: class {} },
  '../platform/PlatformLoader.js': { getPlatform: () => ({ getSpeedtestCliBinPath: () => '/nonexistent/speedtest' }) },
  './ExtensionManager.js': {
    onGet: (name, handler) => { getHandlers[name] = handler; },
    onCmd: () => {}
  },
  '../net2/SysManager.js': { getInterfaceViaUUID: (uuid) => interfaces[uuid] },
  '../util/redis_manager.js': { getRedisClient: () => ({}), getSubscriptionClient: () => ({}) },
  '../extension/metrics/metrics.js': {}
});

describe('InternetSpeedtestPlugin internetSpeedtestServers', () => {
  let calls;
  let getServers;

  before(async () => {
    const plugin = new InternetSpeedtestPlugin({});
    plugin.listAvailableServers = async (bindIP, dnsServers, vendor) => {
      calls.push({ bindIP, dnsServers, vendor });
      return [];
    };
    await plugin.apiRun();
    getServers = getHandlers.internetSpeedtestServers;
  });

  beforeEach(() => {
    calls = [];
    for (const uuid of Object.keys(interfaces))
      delete interfaces[uuid];
  });

  it('binds to the WAN IP when the WAN has no dns', async () => {
    interfaces['wan-1'] = { name: 'eth0', uuid: 'wan-1', ip_address: '10.0.0.2' };

    const result = await getServers({}, { wanUUID: 'wan-1' });

    expect(result).to.eql({ servers: [] });
    expect(calls).to.eql([{ bindIP: '10.0.0.2', dnsServers: null, vendor: 'ookla' }]);
  });

  it('rejects a WAN that has dns but no IP address', async () => {
    interfaces['wan-2'] = { name: 'eth1', uuid: 'wan-2', dns: ['1.1.1.1'] };

    let error = null;
    try {
      await getServers({}, { wanUUID: 'wan-2' });
    } catch (err) {
      error = err;
    }

    // without a bind IP the servers would be listed over the default route
    expect(calls).to.eql([]);
    expect(error).to.not.equal(null);
    expect(error.code).to.equal(400);
    expect(error.msg).to.contain('eth1 does not have IP address');
  });

  it('passes both the WAN IP and its dns servers', async () => {
    interfaces['wan-3'] = { name: 'eth2', uuid: 'wan-3', ip_address: '10.0.1.2', dns: ['10.0.1.1', '8.8.8.8'] };

    await getServers({}, { wanUUID: 'wan-3' });

    expect(calls).to.eql([{ bindIP: '10.0.1.2', dnsServers: ['10.0.1.1', '8.8.8.8'], vendor: 'ookla' }]);
  });
});
