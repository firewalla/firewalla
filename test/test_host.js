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

'use strict'

let chai = require('chai');
let expect = chai.expect;

const log = require('../net2/logger.js')(__filename)
const Host = require('../net2/Host.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const fc = require('../net2/config.js');
const Monitorable = require('../net2/Monitorable.js');
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const MessageBus = require('../net2/MessageBus.js');
const fs = require('fs');

describe('test _get24HoursTopDomains', function(){
  const testMac = 'AA:BB:CC:DD:EE:FF';
  const testApp = 'test';
  this.timeout(20000);

  // Setup function: create test host and populate test data
  async function setupTestData() {
    // Create a test host
    const host = new Host({ mac: testMac, lastActiveTimestamp: Date.now() });
    const testKeys = []; // Store all test keys for cleanup

    // Calculate current hour timestamp
    const now = Math.floor(Date.now() / 1000);
    const currentHour = new Date(now * 1000);
    currentHour.setMinutes(0, 0, 0);
    currentHour.setSeconds(0, 0, 0);
    currentHour.setMilliseconds(0);
    const currentHourTs = Math.floor(currentHour.getTime() / 1000);

    // Create test data for past 24 hours
    // Add data for 3 hours ago (regular hour, not midnight)
    const hour3Ago = currentHourTs - 3 * 3600;
    const key1 = `flow_domain:${testApp}:${testMac}:${hour3Ago}`;
    testKeys.push(key1);
    await rclient.zincrbyAsync(key1, 100, 'google.com');
    await rclient.zincrbyAsync(key1, 200, 'youtube.com');
    await rclient.zincrbyAsync(key1, 150, 'facebook.com');

    // Add data for 5 hours ago (regular hour)
    const hour5Ago = currentHourTs - 5 * 3600;
    const key2 = `flow_domain:${testApp}:${testMac}:${hour5Ago}`;
    testKeys.push(key2);
    await rclient.zincrbyAsync(key2, 300, 'google.com'); // Total count for google.com will be 400
    await rclient.zincrbyAsync(key2, 50, 'twitter.com');

    // Add data for midnight hours (1:00-5:00)
    // Create a date for 2:00 AM in the past 24 hours
    const midnightBase = new Date(now * 1000);
    midnightBase.setHours(2, 0, 0, 0);
    // If 2 AM hasn't happened yet today, use yesterday's 2 AM
    if (midnightBase.getTime() / 1000 > now) {
      midnightBase.setDate(midnightBase.getDate() - 1);
    }
    const hour2AMTs = Math.floor(midnightBase.getTime() / 1000);
    const key3 = `flow_domain:${testApp}:${testMac}:${hour2AMTs}`;
    testKeys.push(key3);
    await rclient.zincrbyAsync(key3, 500, 'netflix.com');
    await rclient.zincrbyAsync(key3, 250, 'youtube.com'); // Total count for youtube.com in midnight will be 250

    // Create a timestamp for 3:00 AM (within past 24 hours)
    const midnightBase2 = new Date(now * 1000);
    midnightBase2.setHours(3, 0, 0, 0);
    if (midnightBase2.getTime() / 1000 > now) {
      midnightBase2.setDate(midnightBase2.getDate() - 1);
    }
    const hour3AMTs = Math.floor(midnightBase2.getTime() / 1000);
    const key4 = `flow_domain:${testApp}:${testMac}:${hour3AMTs}`;
    testKeys.push(key4);
    await rclient.zincrbyAsync(key4, 400, 'netflix.com'); // Total count for netflix.com in midnight will be 900
    await rclient.zincrbyAsync(key4, 100, 'amazon.com');

    // Add data for a non-midnight hour (10:00 AM) to ensure it's not included in midnight stats
    // Create a date for 10:00 AM in the past 24 hours
    const morningBase = new Date(now * 1000);
    morningBase.setHours(10, 0, 0, 0);
    // If 10 AM hasn't happened yet today, use yesterday's 10 AM
    if (morningBase.getTime() / 1000 > now) {
      morningBase.setDate(morningBase.getDate() - 1);
    }
    const hour10AMTs = Math.floor(morningBase.getTime() / 1000);
    const key5 = `flow_domain:${testApp}:${testMac}:${hour10AMTs}`;
    testKeys.push(key5);
    await rclient.zincrbyAsync(key5, 600, 'github.com');

    log.info('Created test keys:', testKeys);

    for (const key of testKeys) {
      const value = await rclient.zrangeAsync(key, 0, -1, 'withscores');
      log.info(`Key: ${key}, Value: ${value}`);
    }
    
    return { host, testKeys };
  }

  // Cleanup function: remove test data
  async function cleanupTestData(host, testKeys) {
    // Clean up all keys with flow_domain:test prefix
    const pattern = 'flow_domain:test:*';
    let cursor = '0';
    let deletedCount = 0;
    
    do {
      try {
        const scanResult = await rclient.scanAsync(cursor, 'match', pattern, 'count', 100);
        cursor = scanResult[0];
        const keys = scanResult[1];
        
        if (keys && keys.length > 0) {
          for (const key of keys) {
            try {
              await rclient.delAsync(key);
              deletedCount++;
            } catch (err) {
              log.warn(`Failed to delete test key ${key}:`, err.message);
            }
          }
        }
      } catch (err) {
        log.error(`Failed to scan keys with pattern ${pattern}:`, err.message);
        break;
      }
    } while (cursor !== '0');
    
    log.info(`Cleaned up ${deletedCount} test keys with pattern ${pattern}`);
    
    // Clean up test host
    if (host) {
      await host.destroy();
    }
    
    log.info('Cleaned up test data');
  }

  it('should fetch device traffic stats for last 24 hours and midnight', async() => {
    const { host, testKeys } = await setupTestData();
    
    try {
    const stats = await host._get24HoursTopDomains(testApp);

    // Verify structure
    expect(stats).to.have.property('last24Hours');
    expect(stats).to.have.property('last24HoursMidnight');
    expect(stats.last24Hours).to.be.an('array');
    expect(stats.last24HoursMidnight).to.be.an('array');

    // Verify last24Hours data
    // Should include all domains from all hours
    const last24HoursDomains = stats.last24Hours.map(item => item.domain);
    expect(last24HoursDomains).to.include('google.com');
    expect(last24HoursDomains).to.include('youtube.com');
    expect(last24HoursDomains).to.include('facebook.com');
    expect(last24HoursDomains).to.include('twitter.com');
    expect(last24HoursDomains).to.include('netflix.com');
    expect(last24HoursDomains).to.include('amazon.com');
    expect(last24HoursDomains).to.include('github.com');

    // Verify aggregation: google.com should have total count of 400 (100 + 300)
    const googleEntry = stats.last24Hours.find(item => item.domain === 'google.com');
    expect(googleEntry).to.exist;
    expect(googleEntry.count).to.equal(400);

    // Verify sorting: should be sorted by count descending
    for (let i = 0; i < stats.last24Hours.length - 1; i++) {
      expect(stats.last24Hours[i].count).to.be.at.least(stats.last24Hours[i + 1].count);
    }

    // Verify midnight data
    // Should only include domains from midnight hours (1:00-5:00)
    const midnightDomains = stats.last24HoursMidnight.map(item => item.domain);
    expect(midnightDomains).to.include('netflix.com');
    expect(midnightDomains).to.include('youtube.com');
    expect(midnightDomains).to.include('amazon.com');
    // Should NOT include domains from non-midnight hours
    expect(midnightDomains).to.not.include('github.com');
    expect(midnightDomains).to.not.include('google.com');
    expect(midnightDomains).to.not.include('facebook.com');
    expect(midnightDomains).to.not.include('twitter.com');

    // Verify aggregation for midnight: netflix.com should have total count of 900 (500 + 400)
    const netflixEntry = stats.last24HoursMidnight.find(item => item.domain === 'netflix.com');
    expect(netflixEntry).to.exist;
    expect(netflixEntry.count).to.equal(900);

    // Verify sorting for midnight: should be sorted by count descending
    for (let i = 0; i < stats.last24HoursMidnight.length - 1; i++) {
      expect(stats.last24HoursMidnight[i].count).to.be.at.least(stats.last24HoursMidnight[i + 1].count);
    }

    // Verify top 10 limit
    expect(stats.last24Hours.length).to.be.at.most(10);
    expect(stats.last24HoursMidnight.length).to.be.at.most(10);
    } finally {
      await cleanupTestData(host, testKeys);
    }
  });

  it('should return empty arrays when no data exists', async() => {
    // Create a host with no data
    const emptyHost = new Host({ mac: '11:22:33:44:55:66', lastActiveTimestamp: Date.now() });
    
    const stats = await emptyHost._get24HoursTopDomains(testApp);
    
    expect(stats.last24Hours).to.be.an('array').that.is.empty;
    expect(stats.last24HoursMidnight).to.be.an('array').that.is.empty;

    // Cleanup
    await emptyHost.destroy();
  });

  it('should get device traffic activity for past 24 hours', async() => {
    // Create a host
    const host = new Host({ mac: '6C:1F:F7:23:39:CB', lastActiveTimestamp: Date.now() });
    
    // Call _get24HoursInternetActivity
    const activity = await host._get24HoursInternetActivity();
    
    // Verify structure: should return activity statistics
    expect(activity).to.exist;
    expect(activity).to.be.an('object');
    expect(activity).to.have.property('last24HoursTotal');
    expect(activity).to.have.property('last24HoursMidnight');
    
    // Verify all values are numbers
    expect(activity.last24HoursTotal).to.be.a('number');
    expect(activity.last24HoursMidnight).to.be.a('number');
    
    // Verify values are non-negative
    expect(activity.last24HoursTotal).to.be.at.least(0);
    expect(activity.last24HoursMidnight).to.be.at.least(0);
    
    // Verify logical relationships
    // Midnight minutes should be <= total minutes for the same period
    expect(activity.last24HoursMidnight).to.be.at.most(activity.last24HoursTotal);

    // Cleanup
    await host.destroy();
  });

  it('should fetch 24 hours internet activity stats', async() => {
    // Create a host
    const host = new Host({ mac: '6C:1F:F7:23:39:CB', lastActiveTimestamp: Date.now() });
    
    // Call fetch24HoursInternetActivityStats
    const stats = await host.fetch24HoursInternetActivityStats();
    
    // Verify structure: should return stats with activityMinutes and topDomains
    expect(stats).to.exist;
    expect(stats).to.be.an('object');
    expect(stats).to.have.property('activityMinutes');
    expect(stats).to.have.property('topDomains');
    
    // Verify activityMinutes structure
    expect(stats.activityMinutes).to.be.an('object');
    expect(stats.activityMinutes).to.have.property('last24HoursTotal');
    expect(stats.activityMinutes).to.have.property('last24HoursMidnight');
    
    // Verify activityMinutes values are numbers and non-negative
    expect(stats.activityMinutes.last24HoursTotal).to.be.a('number').that.is.at.least(0);
    expect(stats.activityMinutes.last24HoursMidnight).to.be.a('number').that.is.at.least(0);
    
    // Verify activityMinutes logical relationships
    // Midnight minutes should be <= total minutes for the same period
    expect(stats.activityMinutes.last24HoursMidnight).to.be.at.most(stats.activityMinutes.last24HoursTotal);
    
    // Verify topDomains structure
    expect(stats.topDomains).to.be.an('object');
    expect(stats.topDomains).to.have.property('last24Hours');
    expect(stats.topDomains).to.have.property('last24HoursMidnight');
    expect(stats.topDomains.last24Hours).to.be.an('array');
    expect(stats.topDomains.last24HoursMidnight).to.be.an('array');
    
    // Verify topDomains arrays contain hashed domains and count
    for (const item of stats.topDomains.last24Hours) {
      expect(item._domain).to.be.a('string');
      expect(item._domainFull).to.be.a('string');
      expect(item).to.have.property('count');
      expect(item.count).to.be.a('number').that.is.at.least(0);
    }
    
    for (const item of stats.topDomains.last24HoursMidnight) {
      expect(item._domain).to.be.a('string');
      expect(item._domainFull).to.be.a('string');
      expect(item).to.have.property('count');
      expect(item.count).to.be.a('number').that.is.at.least(0);
    }
    
    // Verify topDomains arrays are sorted by count (descending)
    for (let i = 0; i < stats.topDomains.last24Hours.length - 1; i++) {
      expect(stats.topDomains.last24Hours[i].count).to.be.at.least(stats.topDomains.last24Hours[i + 1].count);
    }
    
    for (let i = 0; i < stats.topDomains.last24HoursMidnight.length - 1; i++) {
      expect(stats.topDomains.last24HoursMidnight[i].count).to.be.at.least(stats.topDomains.last24HoursMidnight[i + 1].count);
    }
    
    // Verify top 10 limit
    expect(stats.topDomains.last24Hours.length).to.be.at.most(10);
    expect(stats.topDomains.last24HoursMidnight.length).to.be.at.most(10);

    // Cleanup
    await host.destroy();
  });
});

describe('Host.hostsFileV6Key', function() {

  it('should ignore anything that is not an address array', () => {
    expect(Host.hostsFileV6Key(undefined)).to.equal('');
    expect(Host.hostsFileV6Key(null)).to.equal('');
    expect(Host.hostsFileV6Key({})).to.equal('');
    expect(Host.hostsFileV6Key('{not json')).to.equal('');
  });

  it('should accept the JSON string form stored in redis', () => {
    expect(Host.hostsFileV6Key('["2001:db8::1"]')).to.equal('2001:db8::1');
  });

  it('should drop link local and invalid addresses', () => {
    // only these two affect the rendered hosts file
    expect(Host.hostsFileV6Key(['fe80::1', '2001:db8::1', 'notanip', '2001:db8::2']))
      .to.equal('2001:db8::1,2001:db8::2');
    expect(Host.hostsFileV6Key(['fe80::1', 'fe80::2'])).to.equal('');
  });

  it('should not depend on the order of the addresses', () => {
    expect(Host.hostsFileV6Key(['2001:db8::2', '2001:db8::1']))
      .to.equal(Host.hostsFileV6Key(['2001:db8::1', '2001:db8::2']));
  });
});

describe('Host.updateHostsFileIfChanged', function() {
  const testMac = 'AA:BB:CC:DD:EE:01';
  let host, calls, fail;

  before(() => {
    this.origIsFeatureOn = fc.isFeatureOn;
    fc.isFeatureOn = (name) => name === 'local_domain' ? true : this.origIsFeatureOn(name);
  });

  after(() => {
    fc.isFeatureOn = this.origIsFeatureOn;
    delete Monitorable.instances[testMac];
  });

  beforeEach(() => {
    fc.isFeatureOn = (name) => name === 'local_domain' ? true : this.origIsFeatureOn(name);
    delete Monitorable.instances[testMac];
    host = new Host({ mac: testMac, ipv4Addr: '192.168.1.2', localDomain: 'dev' });
    calls = 0;
    fail = false;
    host.updateHostsFile = async () => {
      calls++;
      if (fail) throw new Error('write failed');
    };
  });

  it('should refresh on the first run and then stay quiet', async() => {
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(1);
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(1);
  });

  it('should refresh when the ipv4 address changes', async() => {
    await host.updateHostsFileIfChanged();
    host.o.ipv4Addr = '192.168.1.3';
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(2);
  });

  it('should refresh on a routable ipv6 change but not on a link local one', async() => {
    await host.updateHostsFileIfChanged();
    host.ipv6Addr = ['2001:db8::1'];
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(2);

    host.ipv6Addr = ['2001:db8::1', 'fe80::1'];
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(2);
  });

  it('should refresh when the local domain changes', async() => {
    await host.updateHostsFileIfChanged();
    host.o.localDomain = 'renamed';
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(2);

    host.o.userLocalDomain = 'custom';
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(3);
  });

  it('should retry after a failed write', async() => {
    fail = true;
    await host.updateHostsFileIfChanged().catch(() => {});
    expect(calls).to.equal(1);

    // nothing changed, but the previous attempt did not go through
    fail = false;
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(2);
  });

  it('should do nothing while local_domain is off', async() => {
    fc.isFeatureOn = () => false;
    await host.updateHostsFileIfChanged();
    expect(calls).to.equal(0);
  });
});

describe('Host._removeHostsFile', function() {
  const testMac = 'AA:BB:CC:DD:EE:03';
  let host, reloads, origUnlink, origReload, unlinkFails;

  before(() => {
    origUnlink = fs.unlinkAsync;
    origReload = Dnsmasq.prototype.scheduleReloadDNSService;
  });

  after(() => {
    fs.unlinkAsync = origUnlink;
    Dnsmasq.prototype.scheduleReloadDNSService = origReload;
    delete Monitorable.instances[testMac];
  });

  beforeEach(() => {
    delete Monitorable.instances[testMac];
    host = new Host({ mac: testMac });
    host._lastHostfileEntries = '1.1.1.1 a.lan';
    reloads = 0;
    unlinkFails = false;
    Dnsmasq.prototype.scheduleReloadDNSService = () => { reloads++; };
    fs.unlinkAsync = async () => { if (unlinkFails) throw new Error('ENOENT'); };
  });

  it('should reload and forget the file after removing it', async() => {
    await host._removeHostsFile();
    expect(reloads).to.equal(1);
    expect(host._lastHostfileEntries).to.equal(null);
  });

  it('should leave everything alone when the unlink fails and the caller did not write the file', async() => {
    unlinkFails = true;
    await host._removeHostsFile();
    expect(reloads).to.equal(0);
    expect(host._lastHostfileEntries).to.equal('1.1.1.1 a.lan');
  });

  it('should reload and forget the file when the unlink fails and the caller asks to force it', async() => {
    unlinkFails = true;
    await host._removeHostsFile(true);
    expect(reloads).to.equal(1);
    expect(host._lastHostfileEntries).to.equal(null);
  });
});

describe('Host.hostsFileEntries', function() {
  let origInterfaces;

  before(() => {
    origInterfaces = sysManager.getInterfaces;
    sysManager.getInterfaces = () => [{ localDomains: ['home'] }, {}];
  });

  after(() => {
    sysManager.getInterfaces = origInterfaces;
  });

  const addrs = [
    { ip: '192.168.1.5', iface: { searchDomains: ['lan1'] } },
    { ip: '192.168.2.5', iface: { searchDomains: ['lan2'] } },
  ];

  it('should name each address under the search domains of its own network', () => {
    const entries = Host.hostsFileEntries(addrs, ['dev'], null, 'lan');
    expect(entries.sort()).to.deep.equal([
      '192.168.1.5 dev.home', '192.168.1.5 dev.lan', '192.168.1.5 dev.lan1',
      '192.168.2.5 dev.home', '192.168.2.5 dev.lan', '192.168.2.5 dev.lan2',
    ]);
  });

  it('should write an IPv6 line once per name, not once per IPv4 address', () => {
    const entries = Host.hostsFileEntries(addrs, ['dev'], ['2001:db8::1', 'fe80::1'], 'lan');
    expect(entries.filter(l => l.startsWith('2001:db8::1 ')).sort())
      .to.deep.equal(['2001:db8::1 dev.home', '2001:db8::1 dev.lan', '2001:db8::1 dev.lan1', '2001:db8::1 dev.lan2']);
    expect(entries.some(l => l.startsWith('fe80::'))).to.equal(false);
  });

  it('should write nothing for a name when there is no address', () => {
    expect(Host.hostsFileEntries([], ['dev'], ['2001:db8::1'], 'lan')).to.deep.equal([]);
  });
});

describe('Host hosts file of a device on several networks', function() {
  const testMac = 'AA:BB:CC:DD:EE:04';
  const NET1_IP = '192.168.1.5', NET2_IP = '192.168.2.5';
  const MINUTE = 60 * 1000;
  let host, origIfaceViaIP, origInterfaces, origIsFeatureOn, origDateNow, now;
  let origGetMACEntry, origWriteConfig, origReload, writes, reloads;

  before(() => {
    origIfaceViaIP = sysManager.getInterfaceViaIP;
    origInterfaces = sysManager.getInterfaces;
    origIsFeatureOn = fc.isFeatureOn;
    origDateNow = Date.now;
    origGetMACEntry = HostTool.prototype.getMACEntry;
    origWriteConfig = Dnsmasq.prototype.writeConfig;
    origReload = Dnsmasq.prototype.scheduleReloadDNSService;
  });

  after(() => {
    sysManager.getInterfaceViaIP = origIfaceViaIP;
    sysManager.getInterfaces = origInterfaces;
    fc.isFeatureOn = origIsFeatureOn;
    Date.now = origDateNow;
    HostTool.prototype.getMACEntry = origGetMACEntry;
    Dnsmasq.prototype.writeConfig = origWriteConfig;
    Dnsmasq.prototype.scheduleReloadDNSService = origReload;
    delete Monitorable.instances[testMac];
  });

  beforeEach(() => {
    // two monitored networks, 192.168.1.0/24 and 192.168.2.0/24, anything else is unknown
    sysManager.getInterfaceViaIP = (ip) => {
      if (ip.startsWith('192.168.1.')) return { uuid: 'net-1', searchDomains: ['net1'] };
      if (ip.startsWith('192.168.2.')) return { uuid: 'net-2', searchDomains: ['net2'] };
      return null;
    };
    sysManager.getInterfaces = () => [];
    fc.isFeatureOn = (name) => name === 'local_domain' ? true : origIsFeatureOn(name);
    now = Date.now();
    Date.now = () => now;
    HostTool.prototype.getMACEntry = async () => ({
      mac: testMac, lastActiveTimestamp: String(Math.floor(now / 1000)), localDomain: 'dev'
    });
    writes = [];
    reloads = 0;
    Dnsmasq.prototype.writeConfig = async (file, entries) => { writes.push(entries.slice()); };
    Dnsmasq.prototype.scheduleReloadDNSService = () => { reloads++; };

    delete Monitorable.instances[testMac];
    host = new Host({ mac: testMac, ipv4Addr: NET1_IP, localDomain: 'dev' });
    host.save = async () => {};
    host.scheduleUpdateHostData = () => {};
    host.scheduleInvalidateHostsFile = () => {};
  });

  afterEach(() => {
    Date.now = origDateNow;
  });

  // what FireMain does for an observation of the device on one network
  const observe = (ip) => host.update({ ipv4: ip, ipv4Addr: ip }, true, true);

  it('should list the address of every network the device was seen on', async() => {
    await observe(NET1_IP);
    await observe(NET2_IP);
    expect(host.o.ipv4Addr).to.equal(NET2_IP);
    expect(host._hostsFileIPv4s()).to.deep.equal([NET1_IP, NET2_IP]);
  });

  it('should not rewrite the hosts file while the stored address alternates', async() => {
    await observe(NET1_IP);
    await observe(NET2_IP);
    await host.updateHostsFileIfChanged();
    expect(writes.length).to.equal(1);
    expect(reloads).to.equal(1);
    // both addresses, each under its own network's search domain
    expect(writes[0]).to.include(`${NET1_IP} dev.net1`);
    expect(writes[0]).to.include(`${NET2_IP} dev.net2`);
    expect(writes[0]).to.not.include(`${NET1_IP} dev.net2`);

    for (let i = 0; i < 3; i++) {
      await observe(NET1_IP);
      await host.updateHostsFileIfChanged();
      await observe(NET2_IP);
      await host.updateHostsFileIfChanged();
    }
    expect(writes.length).to.equal(1);
    expect(reloads).to.equal(1);
  });

  it('should not remember an address from an update that is not saved', async() => {
    await observe(NET1_IP);
    // what onUpdate does with the copy another process published
    await host.update({ ipv4: NET2_IP, ipv4Addr: NET2_IP }, true);
    expect(host._hostsFileIPv4s()).to.deep.equal([NET1_IP, NET2_IP]);
    await observe(NET1_IP);
    expect(host._hostsFileIPv4s()).to.deep.equal([NET1_IP]);
  });

  it('should list only the stored address of its own network', async() => {
    await observe(NET1_IP);
    // a new lease on the same network replaces the old address
    await observe('192.168.1.9');
    expect(host._hostsFileIPv4s()).to.deep.equal(['192.168.1.9']);
    // the stored address changed without a saved observation, the old one on that network is dropped
    await host.update({ ipv4: '192.168.1.7', ipv4Addr: '192.168.1.7' }, true);
    expect(host._hostsFileIPv4s()).to.deep.equal(['192.168.1.7']);
  });

  it('should drop the address of another network once it was not seen for 45 minutes', async() => {
    await observe(NET1_IP);
    now += 10 * MINUTE;
    await observe(NET2_IP);

    now += 34 * MINUTE;       // 44 minutes since net-1 was seen
    expect(host._hostsFileIPv4s()).to.deep.equal([NET1_IP, NET2_IP]);

    now += 2 * MINUTE;        // 46 minutes
    expect(host._hostsFileIPv4s()).to.deep.equal([NET2_IP]);

    // the stored address has no expiry of its own
    now += 5 * 60 * MINUTE;
    expect(host._hostsFileIPv4s()).to.deep.equal([NET2_IP]);
  });

  it('should keep a network alive by seeing the device on it again', async() => {
    await observe(NET1_IP);
    await observe(NET2_IP);
    for (let i = 0; i < 4; i++) {
      now += 30 * MINUTE;
      await observe(NET1_IP);
      await observe(NET2_IP);
    }
    expect(host._hostsFileIPv4s()).to.deep.equal([NET1_IP, NET2_IP]);
  });

  it('should not list an address on a network the box does not monitor', async() => {
    await observe(NET1_IP);
    await observe(NET2_IP);
    sysManager.getInterfaceViaIP = (ip) => ip === NET1_IP ? { uuid: 'net-1', searchDomains: ['net1'] } : null;
    await host.updateHostsFile();
    expect(writes.length).to.equal(1);
    expect(writes[0].every(l => l.startsWith(`${NET1_IP} `))).to.equal(true);
  });

  it('should drop a released address and keep the other networks', async() => {
    let scheduled = 0;
    host.scheduleUpdateHostData = () => { scheduled++; };
    await observe(NET1_IP);
    await observe(NET2_IP);

    // another device took the address of net-1, which is not the stored one
    host.releaseIPv4(NET1_IP);
    expect(host.o.ipv4Addr).to.equal(NET2_IP);
    expect(host._hostsFileIPv4s()).to.deep.equal([NET2_IP]);
    expect(scheduled).to.equal(1);

    // the stored one, nothing is left to list
    host.releaseIPv4(NET2_IP);
    expect(host.o.ipv4Addr).to.equal(undefined);
    expect(host.o.ipv4).to.equal(undefined);
    expect(host._hostsFileIPv4s()).to.deep.equal([]);
    expect(scheduled).to.equal(2);
  });

  it('should not bring a released address back by seeing the device on the other network again', async() => {
    await observe(NET1_IP);
    await observe(NET2_IP);
    host.releaseIPv4(NET1_IP);
    await observe(NET2_IP);
    expect(host._hostsFileIPv4s()).to.deep.equal([NET2_IP]);
  });

  it('should remove the hosts file when no address is left', async() => {
    await observe(NET1_IP);
    await host.updateHostsFile();
    expect(writes.length).to.equal(1);

    const origUnlink = fs.unlinkAsync;
    let unlinks = 0;
    fs.unlinkAsync = async () => { unlinks++; };
    try {
      host.releaseIPv4(NET1_IP);
      await host.updateHostsFile();
    } finally {
      fs.unlinkAsync = origUnlink;
    }
    expect(unlinks).to.equal(1);
    expect(host._lastHostfileEntries).to.equal(null);
  });
});

describe('Host.update publish', function() {
  const testMac = 'AA:BB:CC:DD:EE:05';
  const OLD_IP = '192.168.1.5', NEW_IP = '192.168.1.9';
  const messageBus = new MessageBus('info'); // the instance Host.js publishes on
  let published, origIfaceViaIP;

  before(() => {
    origIfaceViaIP = sysManager.getInterfaceViaIP;
  });

  after(() => {
    sysManager.getInterfaceViaIP = origIfaceViaIP;
    delete Monitorable.instances[testMac];
  });

  beforeEach(() => {
    sysManager.getInterfaceViaIP = () => null;
    published = [];
    messageBus.publish = (...args) => { published.push(args); };
    delete Monitorable.instances[testMac];
  });

  afterEach(() => {
    delete messageBus.publish; // back to the prototype's
  });

  const newHost = (ip) => {
    const host = new Host({ mac: testMac, ipv4Addr: ip, ipv4: ip, lastActiveTimestamp: '100' });
    host.save = async () => {};
    return host;
  };

  it('should publish only the keys the update wrote', async() => {
    // a rename from FireApi, the rest of its copy of the device may be stale
    const host = newHost(OLD_IP);
    await host.update({ customizeDomainName: 'my-pc' }, true, true);

    expect(published.length).to.equal(1);
    const [channel, guid, msg] = published[0];
    expect(channel).to.equal('Host:Updated');
    expect(guid).to.equal(testMac);
    expect(Object.keys(msg).sort()).to.deep.equal(['customizeDomainName', 'userLocalDomain']);
  });

  it('should publish the address when the update changes it', async() => {
    const host = newHost(OLD_IP);
    await host.update({ ipv4: NEW_IP, ipv4Addr: NEW_IP }, true, true);

    const msg = published[0][2];
    expect(msg.ipv4Addr).to.equal(NEW_IP);
    expect(msg).to.not.have.property('lastActiveTimestamp');
  });

  it('should not roll back the address of a subscriber with a stale copy', async() => {
    const sender = newHost(OLD_IP);
    await sender.update({ customizeDomainName: 'my-pc' }, true, true);
    const msg = published[0][2];

    // FireMain already moved the device to the new address
    delete Monitorable.instances[testMac];
    const receiver = newHost(NEW_IP);
    await receiver.update(msg, true); // what onUpdate does with the message

    expect(receiver.o.ipv4Addr).to.equal(NEW_IP);
    expect(receiver.o.customizeDomainName).to.equal('my-pc');
  });
});
