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
  let originalDetector;
  let originalCount;

  beforeEach(() => {
    originalEvalAsync = rclient.evalAsync;
    originalDetector = httpFlow.detector;
    originalCount = configModule.getConfig().sensors.OldDataCleanSensor.user_agent2.count;
  });

  afterEach(() => {
    rclient.evalAsync = originalEvalAsync;
    httpFlow.detector = originalDetector;
    configModule.getConfig().sensors.OldDataCleanSensor.user_agent2.count = originalCount;
  });

  it('uses a configured non-default positive user_agent2 count when saving a new User-Agent', async () => {
    let args;
    configModule.getConfig().sensors.OldDataCleanSensor.user_agent2.count = 7;

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

    expect(args).to.be.an('array').with.length(6);
    expect(args[0]).to.contain('redis.call("TIME")');
    expect(args[0]).to.contain('ZREVRANGE');
    expect(args[1]).to.equal(1);
    expect(args[2]).to.equal('host:user_agent2:00:11:22:33:44:55');
    expect(args[3]).to.equal(2592000);
    expect(args[4]).to.equal(7);
    expect(args[5]).to.be.a('string');
  });

  it('handles user_agent2 count boundary values 0 and 1', () => {
    const config = configModule.getConfig();

    config.sensors.OldDataCleanSensor.user_agent2.count = 0;
    expect(httpFlow.getUserAgentHistoryCount()).to.equal(100);

    config.sensors.OldDataCleanSensor.user_agent2.count = 1;
    expect(httpFlow.getUserAgentHistoryCount()).to.equal(1);
  });

  it('preserves a negative user_agent2 count as unlimited', () => {
    configModule.getConfig().sensors.OldDataCleanSensor.user_agent2.count = -1;
    expect(httpFlow.getUserAgentHistoryCount()).to.equal(-1);
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
    expect(calls[1][4]).to.equal(100);
    expect(calls[1][5]).to.be.a('string');
  });

  it('enforces a non-default retention limit, keeps the newest entries, and refreshes the TTL in Redis', async function () {
    this.timeout(30000);

    const key = `host:user_agent2:test-retention:${process.pid}:${Date.now()}`;
    const expireTime = broConfig.get('userAgent.expires');
    const limit = 3;
    const totalEntries = limit + 5;
    configModule.getConfig().sensors.OldDataCleanSensor.user_agent2.count = limit;

    try {
      await rclient.delAsync(key);

      for (let i = 0; i < totalEntries; i++) {
        await httpFlow.saveUserAgentHistory(key, `user-agent-${i}`, expireTime);
      }

      const count = await rclient.zcardAsync(key);
      expect(count).to.equal(limit);

      const members = await rclient.zrangeAsync(key, 0, -1);
      expect(members).to.eql(['user-agent-5', 'user-agent-6', 'user-agent-7']);

      const ttl = await rclient.ttlAsync(key);
      expect(ttl).to.be.within(expireTime - 1, expireTime);
    } finally {
      await rclient.delAsync(key);
    }
  });

  it('keeps a newly written entry when the generated server-time score does not exceed the current max score', async function () {
    this.timeout(30000);

    const key = `host:user_agent2:test-score-collision:${process.pid}:${Date.now()}`;
    const expireTime = broConfig.get('userAgent.expires');
    const futureScore = (Date.now() + 60000) * 1000;
    configModule.getConfig().sensors.OldDataCleanSensor.user_agent2.count = 1;

    try {
      await rclient.delAsync(key);
      // Force the same score-collision/clock-rollback path deterministically without replacing Date.now globally.
      await rclient.zaddAsync([key, futureScore, 'existing-agent']);

      await httpFlow.saveUserAgentHistory(key, 'newest-agent', expireTime);

      const members = await rclient.zrangeAsync(key, 0, -1);
      expect(members).to.eql(['newest-agent']);
    } finally {
      await rclient.delAsync(key);
    }
  });
});
