'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noPreserveCache();

describe('DNSTool deferred DNS TTL refresh bounds', function () {
  const MAX_PENDING = 50000;
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
      './SysManager.js': {'@noCallThru': true},
      '../util/redis_manager.js': {
        getRedisClient: () => redisClient,
        '@noCallThru': true
      },
      '../control/DomainUpdater.js': Object.assign(class {}, {'@noCallThru': true}),
      './Firewalla.js': {
        isProduction: () => true,
        '@noCallThru': true
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

    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'rdns:ip:' + i;
      dnsTool.dnsExpireTs.set(key, now);
      expect(dnsTool.tryRefreshDnsTTL(key, 86400)).to.equal(false);
    }

    const overflowKey = 'rdns:ip:50000';
    dnsTool.dnsExpireTs.set(overflowKey, now);
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 86400)).to.equal(true);

    expect(dnsTool.dnsExpirePending.size).to.equal(MAX_PENDING);
    expect(dnsTool.dnsExpirePending.has('rdns:ip:0')).to.equal(true);
    expect(dnsTool.dnsExpirePending.has(overflowKey)).to.equal(false);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(1);
  });

  it('suppresses an unseen key while overflow suppression is active', () => {
    const now = Date.now();

    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }
    dnsTool.dnsExpireTs.set('key:unseen', now);

    dnsTool.dnsExpireOverflowTs = now;
    expect(dnsTool.tryRefreshDnsTTL('key:unseen', 3600)).to.equal(false);
    expect(dnsTool.dnsExpireTs.has('key:unseen')).to.equal(true);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);
  });

  it('updates an existing pending key while overflow suppression is active', () => {
    const now = Date.now();

    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }
    expect(dnsTool.tryRefreshDnsTTL('key:100', 3600)).to.equal(false);
    expect(dnsTool.dnsExpirePending.size).to.equal(MAX_PENDING);
    expect(dnsTool.dnsExpirePending.get('key:100')).to.equal(3600);
  });

  it('does not evict a pending refresh when updating an existing key at capacity', () => {
    const now = Date.now();

    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    expect(dnsTool.tryRefreshDnsTTL('key:100', 3600)).to.equal(false);
    expect(dnsTool.dnsExpirePending.size).to.equal(MAX_PENDING);
    expect(dnsTool.dnsExpirePending.get('key:100')).to.equal(3600);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);
  });

  it('suppresses distinct overflow keys without growing the pending queue', async () => {
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
    for (let i = 0; i < MAX_PENDING; i++) {
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
    expect(deferredExpires).to.have.length(MAX_PENDING);
    expect(deferredExpires[0]).to.deep.equal(['rdns:ip:0', 86400]);
    expect(deferredExpires[MAX_PENDING - 1]).to.deep.equal(['rdns:ip:49999', 86400]);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);
  });

  it('defers later overflow refreshes after the queue drains', async () => {
    const now = Date.now();

    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    const overflowKey = 'key:overflow';
    dnsTool.dnsExpireTs.set(overflowKey, now);
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 3600)).to.equal(true);
    await dnsTool._drainDnsTTL();

    expect(dnsTool.dnsExpirePending.size).to.equal(0);
    const deferredKey = 'key:0';
    expect(dnsTool.tryRefreshDnsTTL(deferredKey, 7200)).to.equal(false);
    expect(dnsTool.dnsExpirePending.get(deferredKey)).to.equal(7200);

    const expires = [];
    redisClient.expireAsync = (key, expr) => {
      expires.push([key, expr]);
      return Promise.resolve();
    };
    await dnsTool._drainDnsTTL();
    expect(expires).to.deep.equal([[deferredKey, 7200]]);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
  });

  it('aggregates overflow warnings until the pending queue drains', async () => {
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => Promise.resolve()
    });

    const now = Date.now();
    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    for (let i = MAX_PENDING; i < MAX_PENDING + 3; i++) {
      dnsTool.dnsExpireTs.set('key:' + i, now);
      expect(dnsTool.tryRefreshDnsTTL('key:' + i, 3600)).to.equal(i === MAX_PENDING);
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
    const inlineExpires = [];
    redisClient.expireAsync = (key, expr) => {
      inlineExpires.push([key, expr]);
      return Promise.resolve();
    };
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => {
        execCount++;
        if (execCount > 1)
          return Promise.resolve();
        return new Promise((resolve) => {
          resolveExec = resolve;
        });
      }
    });

    for (let i = 0; i < MAX_PENDING - 3; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);

    const firstDrain = dnsTool._drainDnsTTL();
    expect(execCount).to.equal(1);

    for (let i = MAX_PENDING; i < MAX_PENDING * 2; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);
    const secondDrain = dnsTool._drainDnsTTL();

    expect(execCount).to.equal(1);
    expect(dnsTool.dnsExpirePending.size).to.equal(MAX_PENDING);
    expect(secondDrain).to.equal(firstDrain);
    const overflowKeys = ['key:overflow:1', 'key:overflow:2', 'key:overflow:3'];
    const overflowRefreshes = [];
    for (const [index, key] of overflowKeys.entries()) {
      dnsTool.dnsExpireTs.set(key, Date.now());
      const overflowRefresh = dnsTool.tryRefreshDnsTTL(key, 1);
      expect(overflowRefresh).to.equal(index === 0);
      overflowRefreshes.push(overflowRefresh);
      if (overflowRefresh)
        await redisClient.expireAsync(key, 1);
    }
    expect(inlineExpires).to.deep.equal([[overflowKeys[0], 1]]);
    expect(dnsTool.dnsExpirePending.size).to.equal(MAX_PENDING);
    expect(dnsTool.dnsExpireActiveUpdates.size).to.equal(0);

    resolveExec();
    await firstDrain;
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => Promise.resolve()
    });
    await dnsTool._drainDnsTTL();
    await Promise.all(overflowRefreshes);
    expect(execCount).to.equal(2);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
  });

  it('bounds inline Redis calls during sustained overflow', async () => {
    let execResolve;
    let multiExecCount = 0;
    let inlineExpireCount = 0;
    redisClient.expireAsync = () => {
      inlineExpireCount++;
      return Promise.resolve();
    };
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => {
        multiExecCount++;
        return new Promise((resolve) => {
          execResolve = resolve;
        });
      }
    });

    for (let i = 0; i < MAX_PENDING; i++)
      dnsTool.dnsExpirePending.set('key:blocked:' + i, 86400);

    const drain = dnsTool._drainDnsTTL();
    const overflowCalls = 3000;
    let inlineRefreshCount = 0;
    for (let i = 0; i < overflowCalls; i++) {
      const key = 'key:overflow:' + i;
      dnsTool.dnsExpireTs.set(key, Date.now());
      const refreshInline = dnsTool.tryRefreshDnsTTL(key, 3600);
      if (refreshInline) {
        inlineRefreshCount++;
        await redisClient.expireAsync(key, 3600);
      }
    }

    expect(multiExecCount).to.equal(1);
    expect(inlineRefreshCount).to.equal(1);
    expect(inlineExpireCount).to.equal(1);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);
    expect(dnsTool._dnsExpireDeferredSize()).to.equal(MAX_PENDING);

    execResolve();
    await drain;
  });

  it('coalesces an active update when shared deferred capacity is exhausted', () => {
    const now = Date.now();
    dnsTool.dnsExpireActive = new Map([['key:active', 86400]]);
    for (let i = 0; i < MAX_PENDING - 1; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);
    dnsTool.dnsExpireTs.set('key:active', now);

    expect(dnsTool.tryRefreshDnsTTL('key:active', 3600)).to.equal(false);
    expect(dnsTool.dnsExpireActiveUpdates.get('key:active')).to.equal(3600);
    expect(dnsTool.dnsExpirePending.size).to.equal(49999);
    expect(dnsTool._dnsExpireDeferredSize()).to.equal(MAX_PENDING);
  });

  it('keeps aggregate deferred state within capacity during active overflow', () => {
    const now = Date.now();
    const activeKey = 'key:active-bound';
    dnsTool.dnsExpireActive = new Map([[activeKey, 86400]]);
    dnsTool.dnsExpireActiveUpdates.set(activeKey, 3600);
    dnsTool.dnsExpireRetry.set('key:retry-bound', 86400);
    for (let i = 0; i < MAX_PENDING - 2; i++)
      dnsTool.dnsExpirePending.set('key:pending-bound:' + i, 86400);

    expect(dnsTool._dnsExpireDeferredSize()).to.equal(MAX_PENDING);

    for (let i = 0; i < 1000; i++) {
      const key = 'key:overflow-bound:' + i;
      dnsTool.dnsExpireTs.set(key, now);
      expect(dnsTool.tryRefreshDnsTTL(key, 3600)).to.equal(i === 0);
      expect(dnsTool._dnsExpireDeferredSize()).to.be.at.most(MAX_PENDING);
    }
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

  it('coalesces a throttled refresh into a failed retry batch', async () => {
    const operations = [];
    let fail = true;
    redisClient.expireAsync = (key, expr) => {
      operations.push([key, expr]);
      if (fail) {
        fail = false;
        return Promise.reject(new Error('redis unavailable'));
      }
      return Promise.resolve();
    };
    redisClient.multi = () => ({
      expire: (key, expr) => operations.push([key, expr]),
      execAsync: () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error('redis unavailable'));
        }
        return Promise.resolve();
      }
    });

    const key = 'rdns:ip:retry-update';
    dnsTool.dnsExpireTs.set(key, Date.now());
    dnsTool.dnsExpirePending.set(key, 86400);

    await dnsTool._drainDnsTTL();
    expect(dnsTool.dnsExpireRetry.get(key)).to.equal(86400);

    expect(dnsTool.tryRefreshDnsTTL(key, 3600)).to.equal(false);
    expect(dnsTool.dnsExpireRetry.get(key)).to.equal(3600);

    await dnsTool._drainDnsTTL();
    expect(operations).to.deep.equal([
      [key, 86400],
      [key, 3600]
    ]);
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
    dnsTool.dnsExpirePending.set('rdns:ip:in-flight-other', 86400);

    const drain = dnsTool._drainDnsTTL();
    dnsTool.dnsExpireTs.del(key);
    expect(dnsTool.tryRefreshDnsTTL(key, 3600)).to.equal(false);
    expect(operations).to.deep.equal([
      [key, 86400],
      ['rdns:ip:in-flight-other', 86400]
    ]);

    resolveExec();
    await drain;

    expect(operations).to.deep.equal([
      [key, 86400],
      ['rdns:ip:in-flight-other', 86400],
      [key, 3600]
    ]);
  });

  it('serializes an overflow refresh behind an in-flight active refresh', async () => {
    const operations = [];
    let resolveExec;
    let execCount = 0;
    redisClient.multi = () => ({
      expire: (key, expr) => operations.push([key, expr]),
      execAsync: () => {
        execCount++;
        if (execCount === 1) {
          return new Promise((resolve) => {
            resolveExec = resolve;
          });
        }
        return Promise.resolve();
      }
    });
    redisClient.expireAsync = (key, expr) => {
      operations.push([key, expr]);
      return Promise.resolve();
    };

    const key = 'rdns:ip:active-overflow';
    dnsTool.dnsExpireTs.set(key, Date.now());
    dnsTool.dnsExpirePending.set(key, 86400);
    dnsTool.dnsExpirePending.set('rdns:ip:active-overflow-other', 86400);
    const drain = dnsTool._drainDnsTTL();

    for (let i = 0; i < 49997; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);
    expect(dnsTool.tryRefreshDnsTTL(key, 3600)).to.equal(false);
    expect(dnsTool.dnsExpireActiveUpdates.get(key)).to.equal(3600);
    expect(operations.some(([expireKey, expr]) => expireKey === key && expr === 3600)).to.equal(false);

    resolveExec();
    await drain;

    expect(operations.some(([expireKey, expr]) => expireKey === key && expr === 3600)).to.equal(true);
  });
});
