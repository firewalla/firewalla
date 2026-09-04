'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noPreserveCache();

describe('DNSTool deferred DNS TTL refresh bounds', function () {
  let dnsTool;
  let redisClient;
  let warnings;

  before(() => {
    warnings = [];
    redisClient = {
      expireAsync: () => Promise.resolve(),
      multi: () => ({
        expire: () => {},
        execAsync: () => Promise.resolve()
      })
    };

    const DNSTool = proxyquire('../net2/DNSTool.js', {
      './logger.js': () => ({
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {}
      }),
      './SysManager.js': {},
      '../util/redis_manager.js': {
        getRedisClient: () => redisClient
      },
      '../control/DomainUpdater.js': class {},
      './Firewalla.js': {
        isProduction: () => true
      }
    });

    dnsTool = new DNSTool();
  });

  after(() => {
    if (dnsTool && dnsTool.dnsExpireTimer)
      clearInterval(dnsTool.dnsExpireTimer);
  });

  beforeEach(() => {
    dnsTool.dnsExpirePending.clear();
    dnsTool.dnsExpireRetry.clear();
    dnsTool.dnsExpireActive = null;
    dnsTool.dnsExpireActiveUpdates.clear();
    dnsTool.dnsExpireDrainPromise = null;
    dnsTool.dnsExpireTs.reset();
    dnsTool.dnsExpireOverflowTs = 0;
    dnsTool.dnsExpireOverflowCount = 0;
    warnings.length = 0;
  });

  it('keeps all deferred keys and refreshes a new key inline at capacity', () => {
    const now = Date.now();

    for (let i = 0; i < 50000; i++) {
      const key = 'rdns:ip:' + i;
      dnsTool.dnsExpireTs.set(key, now);
      expect(dnsTool.tryRefreshDnsTTL(key, 86400)).to.equal(false);
    }

    const overflowKey = 'rdns:ip:50000';
    dnsTool.dnsExpireTs.set(overflowKey, now);
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 86400)).to.equal(true);

    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.has('rdns:ip:0')).to.equal(true);
    expect(dnsTool.dnsExpirePending.has(overflowKey)).to.equal(false);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(1);
  });

  it('refreshes an unseen key inline while overflow suppression is active', () => {
    const now = Date.now();

    for (let i = 0; i < 50000; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }
    dnsTool.dnsExpireOverflowTs = now;

    expect(dnsTool.tryRefreshDnsTTL('key:unseen', 3600)).to.equal(true);
    expect(dnsTool.dnsExpireTs.has('key:unseen')).to.equal(true);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);
  });

  it('updates an existing pending key while overflow suppression is active', () => {
    const now = Date.now();

    for (let i = 0; i < 50000; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }
    dnsTool.dnsExpireOverflowTs = now;

    expect(dnsTool.tryRefreshDnsTTL('key:100', 3600)).to.equal(false);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.get('key:100')).to.equal(3600);
  });

  it('does not evict a pending refresh when updating an existing key at capacity', () => {
    const now = Date.now();

    for (let i = 0; i < 50000; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    expect(dnsTool.tryRefreshDnsTTL('key:100', 3600)).to.equal(false);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.get('key:100')).to.equal(3600);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);
  });

  it('rate-limits distinct overflow keys globally within the throttle period', async () => {
    const inlineExpires = [];
    const deferredExpires = [];
    redisClient.expireAsync = (key, expr) => {
      inlineExpires.push([key, expr]);
      return Promise.resolve();
    };
    redisClient.multi = () => ({
      expire: (key, expr) => deferredExpires.push([key, expr]),
      execAsync: () => Promise.resolve()
    });

    const now = Date.now();
    for (let i = 0; i < 50000; i++) {
      const key = 'rdns:ip:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    const overflowKeys = ['rdns:ip:50000', 'rdns:ip:50001', 'rdns:ip:50002'];
    for (const key of overflowKeys)
      dnsTool.dnsExpireTs.set(key, now);
    for (let i = 0; i < 3; i++) {
      const key = overflowKeys[i];
      if (dnsTool.tryRefreshDnsTTL(key, 3600))
        await redisClient.expireAsync(key, 3600);
    }
    await dnsTool._drainDnsTTL();

    expect(inlineExpires).to.deep.equal([['rdns:ip:50000', 3600]]);
    expect(deferredExpires).to.deep.equal([
      ...Array.from({ length: 50000 }, (_, i) => ['rdns:ip:' + i, 86400]),
      ['rdns:ip:50001', 3600],
      ['rdns:ip:50002', 3600]
    ]);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);
  });

  it('defers a later refresh for an overflow key after the queue drains', async () => {
    const now = Date.now();

    for (let i = 0; i < 50000; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    const overflowKey = 'key:overflow';
    dnsTool.dnsExpireTs.set(overflowKey, now);
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 3600)).to.equal(true);
    expect(dnsTool.dnsExpireOverflowTs).to.be.a('number').that.is.greaterThan(0);

    await dnsTool._drainDnsTTL();

    expect(dnsTool.dnsExpirePending.size).to.equal(0);
    expect(dnsTool.dnsExpireOverflowTs).to.be.a('number').that.is.greaterThan(0);
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 7200)).to.equal(false);
    expect(dnsTool.dnsExpirePending.get(overflowKey)).to.equal(7200);
    expect(dnsTool.dnsExpireOverflowTs).to.equal(0);
  });

  it('aggregates overflow warnings until the pending queue drains', async () => {
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => Promise.resolve()
    });

    const now = Date.now();
    for (let i = 0; i < 50000; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    for (let i = 50000; i < 50003; i++) {
      dnsTool.dnsExpireTs.set('key:' + i, now);
      expect(dnsTool.tryRefreshDnsTTL('key:' + i, 3600)).to.equal(i === 50000);
    }

    expect(warnings).to.deep.equal([]);

    await dnsTool._drainDnsTTL();

    expect(warnings).to.deep.equal([
      'Deferred rdns TTL refresh limit reached: 50000; refreshed inline: 1'
    ]);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);

    await dnsTool._drainDnsTTL();
    expect(warnings).to.deep.equal([
      'Deferred rdns TTL refresh limit reached: 50000; refreshed inline: 1'
    ]);
  });

  it('does not start overlapping drains while Redis is unresolved', async () => {
    let execCount = 0;
    let resolveExec;
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => {
        execCount++;
        return new Promise((resolve) => {
          resolveExec = resolve;
        });
      }
    });

    for (let i = 0; i < 50000; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);

    const firstDrain = dnsTool._drainDnsTTL();
    expect(execCount).to.equal(1);

    for (let i = 50000; i < 100000; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);
    const secondDrain = dnsTool._drainDnsTTL();

    expect(execCount).to.equal(1);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(secondDrain).to.equal(firstDrain);
    dnsTool.dnsExpireOverflowTs = Date.now();
    dnsTool.dnsExpireTs.set('key:overflow', Date.now());
    expect(dnsTool.tryRefreshDnsTTL('key:overflow', 86400)).to.equal(true);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);

    resolveExec();
    await firstDrain;
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => Promise.resolve()
    });
    await dnsTool._drainDnsTTL();
    expect(execCount).to.equal(1);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
  });

  it('drains retry and pending batches in one serialized cycle', async () => {
    const operations = [];
    let inFlight = 0;
    let maxInFlight = 0;
    redisClient.expireAsync = async (key, expr) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      operations.push([key, expr]);
      await Promise.resolve();
      inFlight--;
    };

    dnsTool.dnsExpireRetry.set('key:retry', 86400);
    dnsTool.dnsExpirePending.set('key:pending', 3600);

    await dnsTool._drainDnsTTL();

    expect(operations).to.deep.equal([
      ['key:retry', 86400],
      ['key:pending', 3600]
    ]);
    expect(maxInFlight).to.equal(1);
    expect(dnsTool.dnsExpireRetry.size).to.equal(0);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
  });

  it('does not retry a stale refresh after a newer inline refresh', async () => {
    const expires = [];
    const queued = [];
    redisClient.multi = () => ({
      expire: (key, expr) => queued.push([key, expr]),
      execAsync: () => {
        queued.length = 0;
        return Promise.reject(new Error('redis unavailable'));
      }
    });
    redisClient.expireAsync = (key, expr) => {
      expires.push([key, expr]);
      return Promise.resolve();
    };

    const key = 'rdns:ip:stale-retry';
    const otherKey = 'rdns:ip:other-retry';
    dnsTool.dnsExpireTs.set(key, Date.now());
    dnsTool.dnsExpireTs.set(otherKey, Date.now());
    dnsTool.dnsExpirePending.set(key, 86400);
    dnsTool.dnsExpirePending.set(otherKey, 86400);

    await dnsTool._drainDnsTTL();
    expect(dnsTool.dnsExpireRetry.get(key)).to.equal(86400);

    dnsTool.dnsExpireTs.del(key);
    expect(dnsTool.tryRefreshDnsTTL(key, 3600)).to.equal(true);
    await redisClient.expireAsync(key, 3600);

    await dnsTool._drainDnsTTL();
    expect(expires.some(([expireKey, expr]) => expireKey === key && expr === 3600)).to.equal(true);
    expect(expires.some(([expireKey, expr]) => expireKey === key && expr === 86400)).to.equal(false);
    expect(dnsTool.dnsExpireRetry.has(key)).to.equal(false);
  });

  it('serializes a newer refresh behind an in-flight active refresh', async () => {
    const operations = [];
    let resolveExec;
    redisClient.multi = () => ({
      expire: (key, expr) => operations.push([key, expr]),
      execAsync: () => new Promise((resolve) => {
        resolveExec = resolve;
      })
    });
    redisClient.expireAsync = (key, expr) => {
      operations.push([key, expr]);
      return Promise.resolve();
    };

    const key = 'rdns:ip:in-flight';
    dnsTool.dnsExpireTs.set(key, Date.now());
    dnsTool.dnsExpirePending.set(key, 86400);

    const drain = dnsTool._drainDnsTTL();
    dnsTool.dnsExpireTs.del(key);
    expect(dnsTool.tryRefreshDnsTTL(key, 3600)).to.equal(false);
    expect(operations).to.deep.equal([[key, 86400]]);

    resolveExec();
    await drain;

    expect(operations).to.deep.equal([[key, 86400], [key, 3600]]);
  });
});
