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
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();

describe('Discovery.discoverMac', () => {
  const targetMac = 'AA:BB:CC:DD:EE:FF';
  const arpHost = {
    ipv4Addr: '192.168.1.20',
    mac: targetMac,
    uid: '192.168.1.20',
    intf: 'eth0'
  };

  function createDiscovery(nmapScanAsync, monitoringInterfaces = [{
    name: 'eth0',
    subnet: '192.168.1.0/24'
  }], fs = null) {
    const nmap = {
      scanAsync: nmapScanAsync
    };
    const sysManager = {
      getMonitoringInterfaces: () => monitoringInterfaces,
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

    const dependencies = {
      './logger.js': () => ({
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: () => {}
      }),
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
    };
    if (fs) {
      dependencies.fs = fs;
    }

    const Discovery = proxyquire('../net2/Discovery.js', dependencies);

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

  it('ignores an ARP match from an unmonitored interface', async () => {
    const scannedSubnets = [];
    const nmapHost = {
      ipv4Addr: '192.168.1.50',
      mac: targetMac
    };
    const discovery = createDiscovery(async (subnet) => {
      scannedSubnets.push(subnet);
      return [nmapHost];
    });

    const unmonitoredArpHost = {
      ipv4Addr: '10.0.0.20',
      mac: targetMac,
      uid: '10.0.0.20',
      intf: 'eth1'
    };
    discovery.getAndSaveArpTable = (callback) => {
      callback(null, {
        [targetMac]: unmonitoredArpHost
      });
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.deep.equal(nmapHost);
    expect(scannedSubnets).to.deep.equal(['192.168.1.0/24']);
  });

  it('ignores an ARP match from an ineligible monitored VPN interface', async () => {
    const scannedSubnets = [];
    const discovery = createDiscovery(async (subnet) => {
      scannedSubnets.push(subnet);
      return [];
    }, [{
      name: 'eth0',
      subnet: '192.168.1.0/24'
    }, {
      name: 'wg0',
      subnet: '10.10.10.0/24'
    }]);

    const vpnArpHost = {
      ipv4Addr: '10.10.10.20',
      mac: targetMac,
      uid: '10.10.10.20',
      intf: 'wg0'
    };
    discovery.getAndSaveArpTable = (callback) => {
      callback(null, {
        [targetMac]: vpnArpHost
      });
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.equal(null);
    expect(scannedSubnets).to.deep.equal(['192.168.1.0/24']);
  });

  it('returns null when both ARP and Nmap miss the target MAC', async () => {
    let scanCalled = false;
    const discovery = createDiscovery(async () => {
      scanCalled = true;
      return [];
    });

    discovery.getAndSaveArpTable = (callback) => {
      callback(null, {});
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.equal(null);
    expect(scanCalled).to.equal(true);
  });

  it('refreshes ARP after unsuccessful scans and returns a late eligible match', async () => {
    let arpReadCount = 0;
    const discovery = createDiscovery(async () => []);

    discovery.getAndSaveArpTable = (callback) => {
      arpReadCount += 1;
      callback(null, arpReadCount === 1 ? {} : {
        [targetMac]: arpHost
      });
    };

    const result = await discovery.discoverMac(targetMac);

    expect(result).to.deep.equal(arpHost);
    expect(arpReadCount).to.equal(2);
  });

  it('parses the ARP interface used by interface eligibility checks', async () => {
    const arpContents = [
      'IP address       HW type     Flags       HW address            Mask     Device',
      `192.168.1.20     0x1         0x2         ${targetMac}     *        eth0`,
      ''
    ].join('\n');
    const fs = {
      readFile: (path, callback) => callback(null, Buffer.from(arpContents))
    };
    const discovery = createDiscovery(async () => [], undefined, fs);

    const arpTable = await new Promise((resolve, reject) => {
      discovery.getAndSaveArpTable((err, result) => err ? reject(err) : resolve(result));
    });

    expect(arpTable[targetMac]).to.include({
      ipv4Addr: '192.168.1.20',
      mac: targetMac,
      uid: '192.168.1.20',
      intf: 'eth0'
    });
  });
});
