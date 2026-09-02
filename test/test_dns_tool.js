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
      '../net2/logger.js': () => ({
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
      '../net2/Firewalla.js': {
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
    dnsTool.dnsExpireTs.reset();
    dnsTool.dnsExpireOverflowTs.reset();
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
    expect(dnsTool.tryRefreshDnsTTL(overflowKey, 86400)).to.equal(true);

    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.has('rdns:ip:0')).to.equal(true);
    expect(dnsTool.dnsExpirePending.has(overflowKey)).to.equal(false);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(1);
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

  it('refreshes an overflow key inline only once within the throttle period', async () => {
    const inlineExpires = [];
    redisClient.expireAsync = (key, expr) => {
      inlineExpires.push([key, expr]);
      return Promise.resolve();
    };

    const now = Date.now();
    for (let i = 0; i < 50000; i++) {
      const key = 'rdns:ip:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    const overflowKey = 'rdns:ip:50000';
    for (let i = 0; i < 3; i++) {
      if (dnsTool.tryRefreshDnsTTL(overflowKey, 3600))
        await redisClient.expireAsync(overflowKey, 3600);
    }

    expect(inlineExpires).to.deep.equal([[overflowKey, 3600]]);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(1);
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
      expect(dnsTool.tryRefreshDnsTTL('key:' + i, 3600)).to.equal(true);
    }

    expect(warnings).to.deep.equal([]);

    await dnsTool._drainDnsTTL();

    expect(warnings).to.deep.equal([
      'Deferred rdns TTL refresh limit reached: 50000; refreshed inline: 3'
    ]);
    expect(dnsTool.dnsExpireOverflowCount).to.equal(0);

    await dnsTool._drainDnsTTL();
    expect(warnings).to.deep.equal([
      'Deferred rdns TTL refresh limit reached: 50000; refreshed inline: 3'
    ]);
  });
});
