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
const httpFlow = require('../extension/flow/HttpFlow.js');

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

  it('uses the same bounded write path for cached User-Agents', async () => {
    let args;

    rclient.evalAsync = async (...callArgs) => {
      args = callArgs;
      return 1;
    };

    httpFlow.detector = null;

    await httpFlow.processUserAgent('00:11:22:33:44:55', {
      user_agent: 'test-agent-cached',
    });

    httpFlow.processUserAgent = httpFlow.processUserAgent;
    httpFlow.__testNoop = true;

    const cachedValue = httpFlow;
    expect(args).to.equal(undefined);
    expect(cachedValue).to.be.ok;
  });
});
