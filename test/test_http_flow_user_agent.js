/*    Copyright 2026 Firewalla Inc.
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
'use strict';

const chai = require('chai');
const expect = chai.expect;

const rclient = require('../util/redis_manager.js').getRedisClient();
const configModule = require('../net2/config.js');
const Getter = configModule.Getter;
const httpFlow = require('../extension/flow/HttpFlow.js');

const broConfig = new Getter('bro');

describe('HttpFlow User-Agent history retention', function () {
  let originalEvalAsync;
  let originalZaddAsync;
  let originalExpireAsync;
  let originalDetector;

  beforeEach(() => {
    originalEvalAsync = rclient.evalAsync;
    originalZaddAsync = rclient.zaddAsync;
    originalExpireAsync = rclient.expireAsync;
    originalDetector = httpFlow.detector;
  });

  afterEach(() => {
    rclient.evalAsync = originalEvalAsync;
    rclient.zaddAsync = originalZaddAsync;
    rclient.expireAsync = originalExpireAsync;
    httpFlow.detector = originalDetector;
  });

  it('uses the configured user_agent2 count when saving a new User-Agent', async () => {
    let args;

    rclient.evalAsync = async (...callArgs) => {
      args = callArgs;
      return 1;
    };

    httpFlow.detector = {
      detect: () => ({
        os: { family: 'Linux', name: 'Linux' },
        client: { name: 'test-client' },
        device: {},
      }),
    };

    await httpFlow.processUserAgent('00:11:22:33:44:55', {
      user_agent: 'test-agent-1',
    });

    expect(args).to.be.an('array').with.length(7);
    expect(args[1]).to.equal(1);
    expect(args[2]).to.equal('host:user_agent2:00:11:22:33:44:55');
    expect(args[3]).to.be.a('number');
    expect(args[4]).to.equal(2592000);
    expect(args[5]).to.equal(100);
    expect(args[6]).to.be.a('string');
  });

  it('preserves a negative user_agent2 count as unlimited', () => {
    const config = configModule.getConfig();
    const originalCount = config.sensors.OldDataCleanSensor.user_agent2.count;
    config.sensors.OldDataCleanSensor.user_agent2.count = -1;

    try {
      expect(httpFlow.getUserAgentHistoryCount()).to.equal(-1);
    } finally {
      config.sensors.OldDataCleanSensor.user_agent2.count = originalCount;
    }
  });

  it('uses the same bounded write path for cached User-Agents', async () => {
    const calls = [];

    rclient.evalAsync = async (...callArgs) => {
      calls.push(callArgs);
      return 1;
    };

    const userAgent = 'test-agent-cached-unique';
    httpFlow.detector = {
      detect: () => ({
        os: { family: 'Linux', name: 'Linux' },
        client: { name: 'test-client' },
        device: {},
      }),
    };

    await httpFlow.processUserAgent('00:11:22:33:44:55', { user_agent: userAgent });

    httpFlow.detector = null;
    await httpFlow.processUserAgent('AA:BB:CC:DD:EE:FF', { user_agent: userAgent });

    expect(calls.length).to.equal(2);
    expect(calls[0][0]).to.contain('ZREMRANGEBYRANK');
    expect(calls[1][0]).to.contain('ZREMRANGEBYRANK');
    expect(calls[1][5]).to.equal(100);
    expect(calls[1][6]).to.be.a('string');
  });

  it('enforces the configured retention limit, keeps the newest entries, and refreshes the TTL in Redis', async function () {
    this.timeout(30000);

    const key = `host:user_agent2:test-retention:${process.pid}:${Date.now()}`;
    const limit = httpFlow.getUserAgentHistoryCount();
    const expireTime = broConfig.get('userAgent.expires');
    const totalEntries = limit + 5;
    const originalDateNow = Date.now;
    const baseTimestamp = Math.floor(originalDateNow() / 1000);

    try {
      await rclient.delAsync(key);

      for (let i = 0; i < totalEntries; i++) {
        Date.now = () => (baseTimestamp + i) * 1000;
        await httpFlow.saveUserAgentHistory(key, `user-agent-${i}`, expireTime);
      }

      const count = await rclient.zcardAsync(key);
      expect(count).to.equal(limit);

      const members = await rclient.zrangeAsync(key, 0, -1);
      const expectedMembers = Array.from(
        { length: limit },
        (_, index) => `user-agent-${totalEntries - limit + index}`
      );
      expect(members).to.eql(expectedMembers);

      const ttl = await rclient.ttlAsync(key);
      expect(ttl).to.be.within(expireTime - 1, expireTime);
    } finally {
      Date.now = originalDateNow;
      await rclient.delAsync(key);
    }
  });
});
