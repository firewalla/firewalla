'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noPreserveCache();

describe('DNSTool deferred DNS TTL refresh bounds', function () {
  let dnsTool;

  before(() => {
    const DNSTool = proxyquire('../net2/DNSTool.js', {
      '../net2/logger.js': () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      }),
      './SysManager.js': {},
      '../util/redis_manager.js': {
        getRedisClient: () => ({})
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

  it('bounds deferred TTL refreshes at 50,000 unique keys', () => {
    const now = Date.now();

    for (let i = 0; i < 50000; i++) {
      const key = 'rdns:ip:' + i;
      dnsTool.dnsExpireTs.set(key, now);
      expect(dnsTool.tryRefreshDnsTTL(key, 86400)).to.equal(false);
    }

    dnsTool.tryRefreshDnsTTL('rdns:ip:50000', 86400);

    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.has('rdns:ip:0')).to.equal(false);
    expect(dnsTool.dnsExpirePending.has('rdns:ip:50000')).to.equal(true);

    dnsTool.tryRefreshDnsTTL('rdns:ip:1', 3600);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.get('rdns:ip:1')).to.equal(3600);
  });

  it('does not evict a pending refresh when updating an existing key at capacity', () => {
    dnsTool.dnsExpirePending.clear();
    dnsTool.dnsExpireTs.reset();

    const now = Date.now();
    for (let i = 0; i < 50000; i++) {
      const key = 'key:' + i;
      dnsTool.dnsExpirePending.set(key, 86400);
      dnsTool.dnsExpireTs.set(key, now);
    }

    expect(dnsTool.tryRefreshDnsTTL('key:100', 3600)).to.equal(false);
    expect(dnsTool.dnsExpirePending.size).to.equal(50000);
    expect(dnsTool.dnsExpirePending.get('key:100')).to.equal(3600);
  });
});
