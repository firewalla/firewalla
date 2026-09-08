'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noPreserveCache();

describe('DNSTool deferred DNS TTL refresh bounds', function () {
  const MAX_PENDING = 50000;
  let dnsTool;
  let redisClient;

  before(() => {
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
        warn: () => {},
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
    dnsTool.dnsExpireCapacityPromise = null;
    dnsTool.dnsExpireCapacityResolve = null;
    dnsTool.dnsExpireTs.reset();
    redisClient.expireAsync = () => Promise.resolve();
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => Promise.resolve()
    });
  });

  it('requests an inline refresh for the leading edge', () => {
    expect(dnsTool.tryRefreshDnsTTL('rdns:ip:1.2.3.4', 86400)).to.equal(true);
  });

  it('coalesces throttled refreshes in the deferred queue', () => {
    const key = 'rdns:ip:1.2.3.4';
    dnsTool.dnsExpireTs.set(key, Date.now());

    expect(dnsTool.tryRefreshDnsTTL(key, 86400)).to.equal(false);
    expect(dnsTool.tryRefreshDnsTTL(key, 60)).to.equal(false);
    expect(dnsTool.dnsExpirePending.get(key)).to.equal(60);
  });

  it('retains every overflow refresh using bounded backpressure', async () => {
    let resolveExec;
    const deferredExpires = [];
    redisClient.multi = () => ({
      expire: (key, expr) => deferredExpires.push([key, expr]),
      execAsync: () => new Promise((resolve) => {
        resolveExec = resolve;
      })
    });

    const now = Date.now();
    for (let i = 0; i < MAX_PENDING; i++) {
      const key = 'key:blocked:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    const drain = dnsTool._drainDnsTTL();
    const overflowKeys = ['key:overflow:1', 'key:overflow:2', 'key:overflow:3'];
    const refreshes = overflowKeys.map((key) => {
      dnsTool.dnsExpireTs.set(key, now);
      return dnsTool.tryRefreshDnsTTL(key, 60);
    });

    expect(dnsTool._dnsExpireDeferredSize()).to.equal(MAX_PENDING);
    expect(dnsTool.dnsExpirePending.size).to.equal(0);

    resolveExec();
    await drain;
    expect(await Promise.all(refreshes)).to.deep.equal([false, false, false]);
    expect(dnsTool.dnsExpirePending.size).to.equal(overflowKeys.length);
    for (const key of overflowKeys)
      expect(dnsTool.dnsExpirePending.get(key)).to.equal(60);

    redisClient.multi = () => ({
      expire: (key, expr) => deferredExpires.push([key, expr]),
      execAsync: () => Promise.resolve()
    });
    await dnsTool._drainDnsTTL();
    expect(deferredExpires.slice(-overflowKeys.length)).to.deep.equal(
      overflowKeys.map((key) => [key, 60])
    );
  });

  it('does not exceed the deferred-state bound while producers wait', async () => {
    let resolveExec;
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: () => new Promise((resolve) => {
        resolveExec = resolve;
      })
    });

    for (let i = 0; i < MAX_PENDING; i++)
      dnsTool.dnsExpirePending.set('key:' + i, 86400);

    const drain = dnsTool._drainDnsTTL();
    const refreshes = [];
    for (let i = 0; i < 1000; i++) {
      const key = 'overflow:' + i;
      dnsTool.dnsExpireTs.set(key, Date.now());
      refreshes.push(dnsTool.tryRefreshDnsTTL(key, 60));
    }
    expect(dnsTool._dnsExpireDeferredSize()).to.equal(MAX_PENDING);

    resolveExec();
    await drain;
    await Promise.all(refreshes);
    expect(dnsTool._dnsExpireDeferredSize()).to.equal(1000);
  });

  it('limits each drain invocation to its initial bounded batch', async () => {
    let execCount = 0;
    const produce = () => {
      execCount++;
      dnsTool.dnsExpirePending.set('key:produced:' + execCount, 60);
      return Promise.resolve();
    };
    redisClient.expireAsync = produce;
    redisClient.multi = () => ({
      expire: () => {},
      execAsync: produce
    });
    dnsTool.dnsExpirePending.set('key:initial:1', 60);
    dnsTool.dnsExpirePending.set('key:initial:2', 60);

    await dnsTool._drainDnsTTL();
    expect(execCount).to.equal(1);
    expect(dnsTool.dnsExpirePending.has('key:produced:1')).to.equal(true);

    await dnsTool._drainDnsTTL();
    expect(execCount).to.equal(2);
    expect(dnsTool.dnsExpirePending.has('key:produced:2')).to.equal(true);
  });

  it('leaves active updates for the next bounded drain', async () => {
    let resolveExec;
    const operations = [];
    redisClient.multi = () => ({
      expire: (key, expr) => operations.push([key, expr]),
      execAsync: () => new Promise((resolve) => {
        resolveExec = resolve;
      })
    });

    const key = 'rdns:ip:active';
    dnsTool.dnsExpireTs.set(key, Date.now());
    dnsTool.dnsExpirePending.set(key, 86400);
    dnsTool.dnsExpirePending.set('rdns:ip:other', 86400);
    const drain = dnsTool._drainDnsTTL();

    expect(dnsTool.tryRefreshDnsTTL(key, 60)).to.equal(false);
    resolveExec();
    await drain;
    expect(dnsTool.dnsExpireActiveUpdates.get(key)).to.equal(60);

    redisClient.expireAsync = (expireKey, expr) => {
      operations.push([expireKey, expr]);
      return Promise.resolve();
    };
    await dnsTool._drainDnsTTL();
    expect(operations[operations.length - 1]).to.deep.equal([key, 60]);
  });

  it('retains a failed batch for a later retry', async () => {
    let fail = true;
    redisClient.expireAsync = () => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('redis unavailable'));
      }
      return Promise.resolve();
    };
    dnsTool.dnsExpirePending.set('key:retry', 60);

    await dnsTool._drainDnsTTL();
    expect(dnsTool.dnsExpireRetry.get('key:retry')).to.equal(60);

    await dnsTool._drainDnsTTL();
    expect(dnsTool.dnsExpireRetry.size).to.equal(0);
  });
});
