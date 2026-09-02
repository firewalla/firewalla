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
const DestURLFoundHook = require('../hook/DestURLFoundHook.js');

describe('DestURLFoundHook URL queue', function () {
  let originalEvalAsync;

  beforeEach(() => {
    originalEvalAsync = rclient.evalAsync;
  });

  afterEach(() => {
    rclient.evalAsync = originalEvalAsync;
  });

  it('uses an atomic Redis script to reject inserts when the queue is full', async () => {
    let args;

    rclient.evalAsync = async (...callArgs) => {
      args = callArgs;
      return 0;
    };

    const hook = new DestURLFoundHook();
    const result = await hook.appendURL({ mac: '00:11:22:33:44:55', url: 'https://example.com/a' });

    expect(result).to.equal(false);
    expect(args).to.be.an('array').with.length(6);
    expect(args[1]).to.equal(1);
    expect(args[2]).to.equal('url_set_to_be_processed');
    expect(args[3]).to.equal(0);
    expect(args[4]).to.equal(2000);
    expect(args[5]).to.equal(JSON.stringify({ mac: '00:11:22:33:44:55', url: 'https://example.com/a' }));
  });


  it('rate-limits full-queue warnings and aggregates dropped URLs', async () => {
    rclient.evalAsync = async () => 0;

    const hook = new DestURLFoundHook();
    const warningCounts = [];
    hook.warnQueueFull = (droppedCount) => {
      warningCounts.push(droppedCount);
    };

    await hook.appendURL({ mac: '00:11:22:33:44:55', url: 'https://example.com/1' });
    expect(warningCounts).to.deep.equal([1]);

    hook.lastQueueDropWarningAt = Date.now();
    await hook.appendURL({ mac: '00:11:22:33:44:55', url: 'https://example.com/2' });
    await hook.appendURL({ mac: '00:11:22:33:44:55', url: 'https://example.com/3' });

    expect(warningCounts).to.deep.equal([1]);
    expect(hook.queueDropCount).to.equal(2);

    hook.lastQueueDropWarningAt = Date.now() - 60 * 1000;
    await hook.appendURL({ mac: '00:11:22:33:44:55', url: 'https://example.com/4' });

    expect(warningCounts).to.deep.equal([1, 3]);
    expect(hook.queueDropCount).to.equal(0);
  });

  it('reports a successful enqueue when Redis accepts the member', async () => {
    let args;

    rclient.evalAsync = async (...callArgs) => {
      args = callArgs;
      return 1;
    };

    const hook = new DestURLFoundHook();
    const info = { mac: '00:11:22:33:44:55', url: 'https://example.com/b' };
    const result = await hook.appendURL(info);

    expect(result).to.equal(true);
    expect(args[0]).to.be.a('string').and.to.contain('zcard');
    expect(args[0]).to.contain('zadd');
    expect(args[2]).to.equal('url_set_to_be_processed');
    expect(args[3]).to.equal(0);
    expect(args[4]).to.equal(2000);
    expect(args[5]).to.equal(JSON.stringify(info));
  });
});
