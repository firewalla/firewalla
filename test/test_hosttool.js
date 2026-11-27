/*    Copyright 2016 Firewalla LLC
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
'use strict'

let chai = require('chai');
let should = chai.should;
let expect = chai.expect;
let assert = chai.assert;

let sample = require('./sample_data');

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

describe.skip('Test Host Tool', () => {

  beforeEach((done) => {
    (async() =>{
      await sample.createSampleHost();
      done();
    })();
  });

  afterEach((done) => {
    (async() =>{
      await sample.removeSampleHost();
      done();
    })();
  });

  describe('.getMacByIP', () => {
    it('should get the right mac address by ip', (done) => {
      (async() =>{
        let macAddress = await hostTool.getMacByIP(sample.hostIP);
        expect(macAddress).to.equal(sample.hostMac)
        done();
      })();
    })
  });

  describe('.getIPsByMac', function() {
    this.timeout(10000);

    it('getIPsByMac should return ipv4 and ipv6 addresses', (done) => {
      (async() =>{
        try {
          let result = await hostTool.getIPsByMac("F4:0F:24:00:00:01");
          expect(result.length).to.equal(3);
          expect(result[0]).to.equal("172.17.0.10");
          expect(result[1]).to.equal("fe80::aa07:d334:59a3:1200");
          expect(result[2]).to.equal("fe80::aa07:d334:59a3:1201");
        } catch(err) {
          assert.fail();
        }
        done();
      })();
    })
  })

  describe('.getAllIPs', () => {
    it('getAllIPs should return all ip address in the network', (done) => {
      (async() =>{
        let allIPs = await hostTool.getAllIPs();
        expect(allIPs.length).to.above(1);
        expect(allIPs.length).to.below(4);
        allIPs.forEach((ip_mac) => {
          if(ip_mac.ip === sample.hostIP) {
            expect(ip_mac.mac).to.equal(sample.hostMac);
          }

          if(ip_mac.ip === sample.hostIP2) {
            expect(ip_mac.mac).to.equal(sample.hostMac2);
          }
        })
        done();
      })();
    })
  })
});

describe('HostTool.removeDupIPv4FromMacEntry', function() {
  const testMac = 'AA:BB:CC:DD:EE:02';
  const testIp = '192.168.9.9';
  const rclient = require('../util/redis_manager.js').getRedisClient();
  const macKey = `host:mac:${testMac}`;

  beforeEach(async() => {
    await rclient.hmsetAsync(macKey, {
      mac: testMac,
      ipv4: testIp,
      ipv4Addr: testIp,
      localDomain: 'olddevice'
    });
  });

  afterEach(async() => {
    await rclient.unlinkAsync(macKey);
    hostTool.invalidateMacEntryCache(testMac);
  });

  it('should drop both ipv4 keys and invalidate the cached entry', async() => {
    // prime the LRU so we can tell the invalidation actually happened
    const before = await hostTool.getMACEntry(testMac);
    expect(before.ipv4Addr).to.equal(testIp);

    await hostTool.removeDupIPv4FromMacEntry(testMac, testIp, 'AA:BB:CC:DD:EE:03');

    const raw = await rclient.hgetallAsync(macKey);
    expect(raw.ipv4).to.be.undefined;
    expect(raw.ipv4Addr).to.be.undefined;
    expect(raw.localDomain).to.equal('olddevice');

    const after = await hostTool.getMACEntry(testMac);
    expect(after.ipv4Addr).to.be.undefined;
  });

  it('should keep an ipv4 that belongs to a different address', async() => {
    await hostTool.removeDupIPv4FromMacEntry(testMac, '192.168.9.10', 'AA:BB:CC:DD:EE:03');
    const raw = await rclient.hgetallAsync(macKey);
    expect(raw.ipv4Addr).to.equal(testIp);
  });
});

describe('HostTool.getAllMACEntries', function() {
  const Constants = require('../net2/Constants.js');
  const rclient = require('../util/redis_manager.js').getRedisClient();
  const indexed = '00:00:5E:00:53:E1';
  const unindexed = '00:00:5E:00:53:E2';
  const recordless = '00:00:5E:00:53:E3';

  before(async() => {
    await hostTool.updateMACKey({ mac: indexed, ipv4Addr: '192.0.2.201', lastActiveTimestamp: Date.now() / 1000 });
    await rclient.hmsetAsync(`host:mac:${unindexed}`, { mac: unindexed, ipv4Addr: '192.0.2.202' });
    await rclient.zaddAsync(Constants.REDIS_KEY_HOST_ACTIVE, Date.now() / 1000, recordless);
  });

  after(async() => {
    for (const mac of [indexed, unindexed, recordless]) {
      await rclient.unlinkAsync(`host:mac:${mac}`);
      await rclient.zremAsync(Constants.REDIS_KEY_HOST_ACTIVE, mac);
      hostTool.invalidateMacEntryCache(mac);
    }
  });

  it('should return the records of the MACs in the index, skipping index members without a record', async() => {
    const macs = (await hostTool.getAllMACEntries()).map(entry => entry.mac);
    expect(macs).to.include(indexed);
    expect(macs).to.not.include(unindexed);
    expect(macs).to.not.include(recordless);
  });
});
