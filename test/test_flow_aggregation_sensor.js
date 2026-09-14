'use strict';

const chai = require('chai');
const expect = chai.expect;

const FlowAggregationSensor = require('../sensor/FlowAggregationSensor.js');
const Constants = require('../net2/Constants.js');

const CACHE_NAMES = [
  'traffic',
  'category',
  'app',
  'ipBlock',
  'dnsBlock',
  'ifBlock'
];

const CACHE_PROPERTIES = {
  traffic: 'trafficCache',
  category: 'categoryFlowCache',
  app: 'appFlowCache',
  ipBlock: 'ipBlockCache',
  dnsBlock: 'dnsBlockCache',
  ifBlock: 'ifBlockCache'
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createSensor() {
  const sensor = Object.create(FlowAggregationSensor.prototype);
  sensor.config = {keySpan: 600};
  sensor.cacheEntryCounts = {};
  sensor.cacheDropCounts = {};
  for (const name of CACHE_NAMES) {
    sensor.cacheEntryCounts[name] = 0;
    sensor.cacheDropCounts[name] = 0;
    sensor[CACHE_PROPERTIES[name]] = Object.create(null);
  }
  return sensor;
}

describe('FlowAggregationSensor cache bounds', () => {
  it('limits each cache generation to the configured maximum number of entries', () => {
    const sensor = createSensor();
    const cache = Object.create(null);

    for (let i = 0; i < 10000; i++) {
      const entry = sensor._getCacheEntry(
        'traffic',
        cache,
        'mac-' + i,
        'entry-' + i,
        () => ({value: i})
      );
      expect(entry).to.deep.equal({value: i});
    }

    const rejected = sensor._getCacheEntry(
      'traffic',
      cache,
      'mac-over-limit',
      'entry-over-limit',
      () => ({value: 'should-not-exist'})
    );

    expect(rejected).to.equal(null);
    expect(sensor.cacheEntryCounts.traffic).to.equal(10000);
    expect(sensor.cacheDropCounts.traffic).to.equal(1);
    expect(hasOwn(cache, 'mac-over-limit')).to.equal(false);
  });

  it('continues updating an existing entry after the cache limit is reached', () => {
    const sensor = createSensor();
    const cache = Object.create(null);

    sensor.cacheEntryCounts.traffic = 10000;
    cache.existing = Object.create(null);
    cache.existing.entry = {
      value: 1
    };

    const entry = sensor._getCacheEntry(
      'traffic',
      cache,
      'existing',
      'entry',
      () => {
        throw new Error('existing cache entry must not be recreated');
      }
    );

    expect(entry.value).to.equal(1);
    expect(sensor.cacheEntryCounts.traffic).to.equal(10000);
    expect(sensor.cacheDropCounts.traffic).to.equal(0);
  });

  it('does not create empty buckets when a cache is already full', () => {
    const sensor = createSensor();
    const cache = Object.create(null);
    sensor.cacheEntryCounts.dnsBlock = 10000;

    const rejected = sensor._getCacheEntry(
      'dnsBlock',
      cache,
      'new-bucket',
      'new-entry',
      () => ({})
    );

    expect(rejected).to.equal(null);
    expect(Object.keys(cache)).to.deep.equal([]);
    expect(sensor.cacheDropCounts.dnsBlock).to.equal(1);
  });

  it('treats constructor and __proto__ as ordinary bounded cache keys', () => {
    const sensor = createSensor();
    const cache = Object.create(null);
    const bucketKey = '__proto__';

    for (const entryKey of ['constructor', '__proto__']) {
      const entry = sensor._getCacheEntry(
        'app',
        cache,
        bucketKey,
        entryKey,
        () => ({key: entryKey})
      );

      expect(entry).to.deep.equal({key: entryKey});
      expect(hasOwn(cache, bucketKey)).to.equal(true);
      expect(hasOwn(cache[bucketKey], entryKey)).to.equal(true);
      expect(cache[bucketKey][entryKey]).to.equal(entry);
    }

    expect(Object.getPrototypeOf(cache)).to.equal(null);
    expect(Object.getPrototypeOf(cache[bucketKey])).to.equal(null);
    expect(sensor.cacheEntryCounts.app).to.equal(2);
  });

  it('does not depend on Object.hasOwn being available', () => {
    const sensor = createSensor();
    const cache = Object.create(null);
    const originalHasOwn = Object.hasOwn;

    try {
      Object.hasOwn = undefined;
      const entry = sensor._getCacheEntry(
        'traffic',
        cache,
        '__proto__',
        'constructor',
        () => ({value: 1})
      );

      expect(entry).to.deep.equal({value: 1});
      expect(hasOwn(cache, '__proto__')).to.equal(true);
      expect(hasOwn(cache.__proto__, 'constructor')).to.equal(true);
    } finally {
      if (originalHasOwn === undefined)
        delete Object.hasOwn;
      else
        Object.hasOwn = originalHasOwn;
    }
  });

  it('routes all six production call sites to the matching bounded cache', async () => {
    const sensor = createSensor();
    const expectedCaches = {};
    for (const name of CACHE_NAMES) {
      expectedCaches[name] = sensor[CACHE_PROPERTIES[name]];
    }

    const seen = {};
    const getCacheEntry = sensor._getCacheEntry;
    sensor._getCacheEntry = function(cacheName, cache, ...args) {
      expect(cache).to.equal(expectedCaches[cacheName]);
      seen[cacheName] = true;
      return getCacheEntry.call(this, cacheName, cache, ...args);
    };

    const mac = 'AA:BB:CC:DD:EE:FF';
    await sensor.processEnrichedFlow({
      fd: 'out',
      _ts: 1200,
      mac,
      ob: 10,
      rb: 20,
      du: 5,
      ts: 1200,
      local: true,
      dmac: '11:22:33:44:55:66',
      ct: 1,
      intel: {
        category: 'constructor',
        app: '__proto__'
      }
    });

    sensor.processBlockFlow({
      type: 'ip',
      mac,
      _ts: 1200,
      dp: 443,
      fd: 'out',
      dir: 'O',
      sh: '1.2.3.4',
      dh: '192.0.2.10',
      ct: 1
    });

    sensor.processBlockFlow({
      type: 'dns',
      mac,
      _ts: 1200,
      dn: 'example.com',
      ct: 1
    });

    sensor.processBlockFlow({
      type: 'ip',
      mac: `${Constants.NS_INTERFACE}:wan-test`,
      _ts: 1200,
      sh: '198.51.100.10',
      ct: 1
    });

    for (const name of CACHE_NAMES) {
      expect(seen[name], `${name} cache call site was not exercised`).to.equal(true);
    }

    expect(hasOwn(sensor.categoryFlowCache[mac], 'constructor')).to.equal(true);
    expect(hasOwn(sensor.appFlowCache[mac], '__proto__')).to.equal(true);
    expect(Object.getPrototypeOf(sensor.categoryFlowCache[mac])).to.equal(null);
    expect(Object.getPrototypeOf(sensor.appFlowCache[mac])).to.equal(null);
  });

  it('resets cache bounds for a new aggregation window', () => {
    const sensor = createSensor();
    sensor.cacheEntryCounts.traffic = 10000;
    sensor.cacheDropCounts.traffic = 25;

    sensor._resetCurrentCacheBounds();

    for (const name of CACHE_NAMES) {
      expect(sensor.cacheEntryCounts[name]).to.equal(0);
      expect(sensor.cacheDropCounts[name]).to.equal(0);
    }
  });

  it('rotates caches and counters together during scheduledJob', async () => {
    const sensor = createSensor();
    const previousCaches = {};

    for (const name of CACHE_NAMES) {
      const cache = sensor[CACHE_PROPERTIES[name]];
      cache.bucket = Object.create(null);
      cache.bucket.entry = {name};
      previousCaches[name] = cache;
      sensor.cacheEntryCounts[name] = 3;
      sensor.cacheDropCounts[name] = 2;
    }

    let aggrArgs;
    let hourlyArgs;
    let sumFlowTs;
    sensor.aggrAll = async (...args) => {
      aggrArgs = args;
    };
    sensor.updateAllHourlySummedFlows = async (...args) => {
      hourlyArgs = args;
    };
    sensor.sumFlowRange = async (ts) => {
      sumFlowTs = ts;
    };

    await sensor.scheduledJob();

    expect(aggrArgs[0]).to.equal(previousCaches.category);
    expect(aggrArgs[1]).to.equal(previousCaches.app);
    expect(hourlyArgs[1]).to.equal(previousCaches.traffic);
    expect(hourlyArgs[2]).to.equal(previousCaches.ipBlock);
    expect(hourlyArgs[3]).to.equal(previousCaches.dnsBlock);
    expect(hourlyArgs[4]).to.equal(previousCaches.ifBlock);
    expect(hourlyArgs[0]).to.equal(sumFlowTs);

    for (const name of CACHE_NAMES) {
      const currentCache = sensor[CACHE_PROPERTIES[name]];
      expect(currentCache).to.not.equal(previousCaches[name]);
      expect(Object.getPrototypeOf(currentCache)).to.equal(null);
      expect(Object.keys(currentCache)).to.deep.equal([]);
      expect(sensor.cacheEntryCounts[name]).to.equal(0);
      expect(sensor.cacheDropCounts[name]).to.equal(0);
    }
  });
});
