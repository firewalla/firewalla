'use strict';

const expect = require('chai').expect;
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();

describe('DNSTool deferred DNS TTL refresh bounds', function () {
  this.timeout(10000);
  const MAX_PENDING = 50000;
  const MAIN_LIMIT = 49000;
  let dnsTool;
  let redisClient;
  let operations;
  let warnings;

  beforeEach(() => {
    operations = [];
    warnings = [];
    redisClient = {
      zaddAsync: () => Promise.resolve(),
      zremAsync: () => Promise.resolve(),
      typeAsync: () => Promise.resolve('zset'),
      expireAsync: (key, expr) => {
        operations.push([key, expr]);
        return Promise.resolve(1);
      },
      multi: () => ({
        expire: (key, expr) => operations.push([key, expr]),
        execAsync: () => Promise.resolve([])
      })
    };
    const DNSTool = proxyquire('../net2/DNSTool.js', {
      './logger.js': () => ({
        debug: () => {}, info: () => {}, error: () => {},
        warn: (message) => warnings.push(message)
      }),
      './SysManager.js': {},
      '../util/redis_manager.js': {getRedisClient: () => redisClient},
      '../control/DomainUpdater.js': class { updateDomainMapping() {} },
      '../control/CategoryUpdater.js': class {},
      '../net2/Firewalla.js': {
        isProduction: () => true,
        isReservedBlockingIP: () => false,
        isMain: () => false
      }
    });
    dnsTool = new DNSTool();
  });

  afterEach(() => {
    if (dnsTool)
      clearInterval(dnsTool.dnsExpireTimer);
  });

  // Independent oracle: count every retained map entry, even duplicate active keys.
  function retainedSize() {
    return dnsTool.dnsExpirePending.size + dnsTool.dnsExpireOverflow.size +
      dnsTool.dnsExpireRetry.size + dnsTool.dnsExpireActiveUpdates.size +
      (dnsTool.dnsExpireActive ? dnsTool.dnsExpireActive.size : 0);
  }

  function assertBound(expected) {
    expect(retainedSize()).to.be.at.most(MAX_PENDING);
    expect(dnsTool._dnsExpireDeferredSize()).to.equal(retainedSize());
    if (expected !== undefined)
      expect(retainedSize()).to.equal(expected);
  }

  function defer(key, expr = 60) {
    dnsTool.dnsExpireTs.set(key, Date.now());
    expect(dnsTool.tryRefreshDnsTTL(key, expr)).to.equal(false);
  }

  function fill(count = MAX_PENDING) {
    for (let i = 0; i < count; i++)
      defer('key:' + i);
  }

  function holdBatch() {
    let resolve;
    let reject;
    let calls = 0;
    redisClient.multi = () => ({
      expire: (key, expr) => operations.push([key, expr]),
      execAsync: () => {
        calls++;
        return new Promise((res, rej) => { resolve = res; reject = rej; });
      }
    });
    return {resolve: () => resolve([]), reject: () => reject(new Error('unavailable')),
      calls: () => calls};
  }

  it('preserves leading-edge and deferred TTL writes through both callers', async () => {
    await dnsTool.addDns('1.2.3.4', 'example.com', 86400);
    await dnsTool.addDns('1.2.3.4', 'example.com', 120);
    await dnsTool.addReverseDns('example.com', ['1.2.3.4'], 86400);
    await dnsTool.addReverseDns('example.com', ['1.2.3.4'], 60);
    expect(operations).to.deep.equal([
      ['rdns:ip:1.2.3.4', 86400], ['rdns:domain:example.com', 86400]
    ]);
    await dnsTool._drainDnsTTL();
    expect(operations.slice(2)).to.deep.equal([
      ['rdns:ip:1.2.3.4', 120], ['rdns:domain:example.com', 60]
    ]);
    assertBound(0);
  });

  it('coalesces throttled refreshes to the latest TTL', () => {
    defer('key', 86400);
    expect(dnsTool.tryRefreshDnsTTL('key', 60)).to.equal(false);
    expect(dnsTool.dnsExpirePending.get('key')).to.equal(60);
    assertBound(1);
  });

  it('bounds 60000 admissions and aggregates overload warnings', async () => {
    fill(60000);
    expect(dnsTool.dnsExpirePending.size).to.equal(MAIN_LIMIT);
    expect(dnsTool.dnsExpireOverflow.size).to.equal(1000);
    expect(dnsTool.dnsExpireDroppedCount).to.equal(10000);
    expect(operations).to.deep.equal([]);
    expect(warnings).to.deep.equal([]);
    assertBound(MAX_PENDING);
    await dnsTool._drainDnsTTL();
    expect(warnings.length).to.equal(1);
    expect(warnings[0]).to.contain('10000');
    expect(dnsTool.dnsExpireDroppedCount).to.equal(0);
    assertBound(1000);
    await dnsTool._drainDnsTTL();
    expect(operations.length).to.equal(MAX_PENDING);
    expect(warnings.length).to.equal(1);
    assertBound(0);
  });

  it('updates existing pending and overflow keys at capacity without eviction', () => {
    fill();
    defer('key:0', 15);
    defer('key:49999', 30);
    expect(dnsTool.dnsExpirePending.get('key:0')).to.equal(15);
    expect(dnsTool.dnsExpireOverflow.get('key:49999')).to.equal(30);
    expect(dnsTool.dnsExpireDroppedCount).to.equal(0);
    assertBound(MAX_PENDING);
  });

  it('keeps retained deferred keys queued when LRU throttle metadata is evicted', () => {
    fill();
    const pendingKey = 'key:0';
    const retryKey = 'key:1';
    const overflowKey = 'key:49999';

    // Move one retained key into retry state while preserving the combined bound.
    dnsTool.dnsExpireRetry.set(retryKey, dnsTool.dnsExpirePending.get(retryKey));
    dnsTool.dnsExpirePending.delete(retryKey);

    // Churn the timestamp LRU past its capacity so these still-retained keys lose
    // their throttle metadata without leaving the deferred queues.
    for (let i = 0; i <= MAX_PENDING; i++)
      dnsTool.dnsExpireTs.set('churn:' + i, Date.now());

    expect(dnsTool.dnsExpireTs.get(pendingKey)).to.equal(undefined);
    expect(dnsTool.dnsExpireTs.get(retryKey)).to.equal(undefined);
    expect(dnsTool.dnsExpireTs.get(overflowKey)).to.equal(undefined);

    expect(dnsTool.tryRefreshDnsTTL(pendingKey, 15)).to.equal(false);
    expect(dnsTool.tryRefreshDnsTTL(retryKey, 30)).to.equal(false);
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 45)).to.equal(false);

    expect(dnsTool.dnsExpirePending.get(pendingKey)).to.equal(15);
    expect(dnsTool.dnsExpireRetry.get(retryKey)).to.equal(30);
    expect(dnsTool.dnsExpireOverflow.get(overflowKey)).to.equal(45);
    expect(dnsTool.dnsExpireDroppedCount).to.equal(0);
    expect(operations).to.deep.equal([]);
    assertBound(MAX_PENDING);
  });

  it('serializes stalled drains and bounds concurrent producers', async () => {
    fill();
    const held = holdBatch();
    const drain = dnsTool._drainDnsTTL();
    try {
      expect(dnsTool._drainDnsTTL()).to.equal(drain);
      for (let i = 0; i < 2000; i++)
        defer('extra:' + i);
      // An active update needs a separate slot; saturation must not allocate it.
      defer('key:0', 15);
      expect(dnsTool.dnsExpireActiveUpdates.size).to.equal(0);
      expect(dnsTool.dnsExpireDroppedCount).to.equal(2001);
      expect(held.calls()).to.equal(1);
      assertBound(MAX_PENDING);
    } finally {
      held.resolve();
      await drain;
    }
    assertBound(1000);
  });

  it('counts active updates separately and coalesces them after completion', async () => {
    fill(MAIN_LIMIT);
    const held = holdBatch();
    const drain = dnsTool._drainDnsTTL();
    try {
      for (let i = 0; i < 1000; i++)
        defer('key:' + i, 120);
      assertBound(MAX_PENDING);
      defer('key:1000', 15);
      expect(dnsTool.dnsExpireDroppedCount).to.equal(1);
    } finally {
      held.resolve();
      await drain;
    }
    assertBound(1000);
    defer('key:0', 30);
    expect(dnsTool.dnsExpirePending.has('key:0')).to.equal(false);
    expect(dnsTool.dnsExpireActiveUpdates.get('key:0')).to.equal(30);
    redisClient.multi = () => ({
      expire: (key, expr) => operations.push([key, expr]),
      execAsync: () => Promise.resolve([])
    });
    await dnsTool._drainDnsTTL();
    expect(operations.slice(MAIN_LIMIT)[0]).to.deep.equal(['key:0', 30]);
    assertBound(0);
  });

  it('counts pending, overflow, retry, active and active-update state together', async () => {
    // Seed the container mix to exercise accounting independent of drain priority.
    for (let i = 0; i < 10000; i++) {
      dnsTool.dnsExpirePending.set('pending:' + i, 60);
      dnsTool.dnsExpireRetry.set('retry:' + i, 60);
      dnsTool.dnsExpireActiveUpdates.set('update:' + i, 60);
    }
    dnsTool.dnsExpireActive = new Map();
    for (let i = 0; i < 19000; i++)
      dnsTool.dnsExpireActive.set('active:' + i, 60);
    for (let i = 0; i < 1000; i++)
      defer('overflow:' + i);
    assertBound(MAX_PENDING);
    defer('extra');
    expect(dnsTool.dnsExpireDroppedCount).to.equal(1);
    assertBound(MAX_PENDING);
  });

  it('retains failed batches at capacity without blocking or retry loops', async () => {
    fill();
    let calls = 0;
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => { calls++; return Promise.reject(new Error('unavailable')); }
    });
    await dnsTool._drainDnsTTL();
    expect(dnsTool.dnsExpireRetry.size).to.equal(MAIN_LIMIT);
    expect(dnsTool.dnsExpireOverflow.size).to.equal(1000);
    defer('key:0', 15);
    expect(dnsTool.dnsExpireRetry.get('key:0')).to.equal(15);
    defer('extra');
    assertBound(MAX_PENDING);
    await dnsTool._drainDnsTTL();
    expect(calls).to.equal(2);
    assertBound(MAX_PENDING);
  });

  it('keeps newer active updates when a batch fails', async () => {
    fill(MAIN_LIMIT);
    const held = holdBatch();
    const drain = dnsTool._drainDnsTTL();
    try {
      defer('key:0', 15);
      assertBound(MAIN_LIMIT + 1);
    } finally {
      held.reject();
      await drain;
    }
    expect(dnsTool.dnsExpireRetry.has('key:0')).to.equal(false);
    expect(dnsTool.dnsExpirePending.get('key:0')).to.equal(15);
    assertBound(MAIN_LIMIT);
    redisClient.multi = () => ({expire: () => {}, execAsync: () => Promise.resolve([])});
    await dnsTool._drainDnsTTL();
    assertBound(1);
    await dnsTool._drainDnsTTL();
    expect(operations[operations.length - 1]).to.deep.equal(['key:0', 15]);
    assertBound(0);
  });

  it('retries a single failed EXPIRE', async () => {
    defer('key', 60);
    redisClient.expireAsync = () => Promise.reject(new Error('unavailable'));
    await dnsTool._drainDnsTTL();
    expect(dnsTool.dnsExpireRetry.get('key')).to.equal(60);
    redisClient.expireAsync = (key, expr) => {
      operations.push([key, expr]);
      return Promise.resolve(1);
    };
    await dnsTool._drainDnsTTL();
    expect(operations).to.deep.equal([['key', 60]]);
    assertBound(0);
  });

  it('limits a drain to its initial batch while producers continue', async () => {
    let calls = 0;
    const produce = () => { calls++; defer('new:' + calls); return Promise.resolve([]); };
    redisClient.multi = () => ({expire: () => {}, execAsync: produce});
    redisClient.expireAsync = produce;
    defer('initial:1');
    defer('initial:2');
    await dnsTool._drainDnsTTL();
    expect(calls).to.equal(1);
    assertBound(1);
    await dnsTool._drainDnsTTL();
    expect(calls).to.equal(2);
    assertBound(1);
  });

  it('removes stale overflow before a new leading-edge refresh', async () => {
    dnsTool.dnsExpireOverflow.set('key', 86400);
    dnsTool.dnsExpireTs.set('key', Date.now() - 1800001);
    expect(dnsTool.tryRefreshDnsTTL('key', 60)).to.equal(true);
    assertBound(0);
    await dnsTool._drainDnsTTL();
    expect(operations).to.deep.equal([]);
  });

  it('clears unsent deferred state through both removal callers', async () => {
    const entries = [['rdns:ip:1.2.3.4', () => dnsTool.removeDns('1.2.3.4', 'example.com')],
      ['rdns:domain:example.com', () => dnsTool.removeReverseDns('example.com', '1.2.3.4')]];
    for (const [key, remove] of entries) {
      for (const queue of [dnsTool.dnsExpirePending, dnsTool.dnsExpireOverflow,
        dnsTool.dnsExpireRetry, dnsTool.dnsExpireActiveUpdates])
        queue.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, Date.now());
      await remove();
      assertBound(0);
      expect(dnsTool.tryRefreshDnsTTL(key, 60)).to.equal(true);
    }
  });
});
