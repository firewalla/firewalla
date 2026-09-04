/*    Copyright 2016-2026 Firewalla Inc.
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

const expect = require('chai').expect;
const proxyquire = require('proxyquire').noPreserveCache();

describe('Discovery.discoverMac', () => {
  const targetMac = 'AA:BB:CC:DD:EE:FF';
  const arpHost = {
    ipv4Addr: '192.168.1.20',
    mac: targetMac,
    uid: '192.168.1.20'
  };

  function createDiscovery(nmapScanAsync) {
    const nmap = {
      scanAsync: nmapScanAsync
    };
    const sysManager = {
      getMonitoringInterfaces: () => [{
        name: 'eth0',
        subnet: '192.168.1.0/24'
      }],
      release: () => {}
    };
    const redisClient = {
      quit: () => {}
    };
    const pclient = {
      publishAsync: async () => {}
    };
    const MessageBus = function MessageBus() {
      this.publish = () => {};
    };
    const platform = {
      isFireRouterManaged: () => false
    };

    const Discovery = proxyquire('../net2/Discovery.js', {
      './Nmap.js': nmap,
      './SysManager.js': sysManager,
      '../sensor/SensorEventManager.js': {
        getInstance: () => ({
          emitEvent: () => {}
        })
      },
      '../util/redis_manager.js': {
        getRedisClient: () => redisClient,
        getPublishClient: () => pclient
      },
      './NetworkTool.js': () => ({
        listInterfaces: async () => []
      }),
      '../platform/PlatformLoader.js': {
        getPlatform: () => platform
      },
      './config.js': {
        getConfig: () => ({})
      },
      './FireRouter.js': {
        init: async () => {},
        getSysNetworkInfo: async () => []
      },
      './Message.js': {},
      './MessageBus.js': MessageBus
    });

    return new Discovery('test-discovery');
  }

  it('returns an ARP match without starting a subnet-wide Nmap scan', async () => {
    let scanCalled = false;
    const discovery = createDiscovery(async () => {
      scanCalled = true;
      throw new Error('Nmap should not be called for an ARP hit');
    });

    discovery.getAndSaveArpTable = (callback) => {
      callback(null, {
        [targetMac]: arpHost
      });
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.deep.equal(arpHost);
    expect(scanCalled).to.equal(false);
  });

  it('falls back to Nmap when the ARP table cannot be read', async () => {
    let scanCalled = false;
    const nmapHost = {
      ipv4Addr: '192.168.1.40',
      mac: targetMac
    };
    const discovery = createDiscovery(async () => {
      scanCalled = true;
      return [nmapHost];
    });

    discovery.getAndSaveArpTable = (callback) => {
      callback(new Error('ARP table unavailable'), {});
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.deep.equal(nmapHost);
    expect(scanCalled).to.equal(true);
  });

  it('falls back to Nmap when the target MAC is absent from ARP', async () => {
    let scanCalled = false;
    const nmapHost = {
      ipv4Addr: '192.168.1.30',
      mac: targetMac
    };
    const discovery = createDiscovery(async () => {
      scanCalled = true;
      return [nmapHost];
    });

    discovery.getAndSaveArpTable = (callback) => {
      callback(null, {});
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.deep.equal(nmapHost);
    expect(scanCalled).to.equal(true);
  });
});
