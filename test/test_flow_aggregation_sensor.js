'use strict';

const chai = require('chai');
const expect = chai.expect;

const FlowAggregationSensor = require('../sensor/FlowAggregationSensor.js');

const CACHE_NAMES = [
  'traffic',
  'category',
  'app',
  'ipBlock',
  'dnsBlock',
  'ifBlock'
];

function createSensor() {
  const sensor = Object.create(FlowAggregationSensor.prototype);
  sensor.cacheEntryCounts = {};
  sensor.cacheDropCounts = {};
  for (const name of CACHE_NAMES) {
    sensor.cacheEntryCounts[name] = 0;
    sensor.cacheDropCounts[name] = 0;
  }
  return sensor;
}

describe('FlowAggregationSensor cache bounds', () => {
  it('limits each cache generation to the configured maximum number of entries', () => {
    const sensor = createSensor();
    const cache = {};

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
    expect(cache).to.not.have.property('mac-over-limit');
  });

  it('continues updating an existing entry after the cache limit is reached', () => {
    const sensor = createSensor();
    const cache = {};

    sensor.cacheEntryCounts.traffic = 10000;
    cache.existing = {
      entry: {
        value: 1
      }
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
    const cache = {};
    sensor.cacheEntryCounts.dnsBlock = 10000;

    const rejected = sensor._getCacheEntry(
      'dnsBlock',
      cache,
      'new-bucket',
      'new-entry',
      () => ({})
    );

    expect(rejected).to.equal(null);
    expect(cache).to.deep.equal({});
    expect(sensor.cacheDropCounts.dnsBlock).to.equal(1);
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
});
