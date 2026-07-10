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
    
    // Verify topDomains arrays contain objects with domain and count
    for (const item of stats.topDomains.last24Hours) {
      expect(item).to.have.property('domain');
      expect(item).to.have.property('count');
      expect(item.domain).to.be.a('string');
      expect(item.count).to.be.a('number').that.is.at.least(0);
    }
    
    for (const item of stats.topDomains.last24HoursMidnight) {
      expect(item).to.have.property('domain');
      expect(item).to.have.property('count');
      expect(item.domain).to.be.a('string');
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
