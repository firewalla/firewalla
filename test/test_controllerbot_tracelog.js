/*    Copyright 2016-2026 Firewalla Inc.
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

'use strict'

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');
const rclient = require('../util/redis_manager').getRedisClient();
const Constants = require('../net2/Constants.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

// Trace() is captured through the module boundary, the RecordAction event through sem, so the
// split recordTracelog makes between the two sinks can be asserted (#9465)
const traced = [];
const ControllerBot = proxyquire('../lib/ControllerBot.js', {
  '../util/audit.js': (mtype, item, target, tracelog) => traced.push({ mtype, item, target, tracelog })
});

describe('Test ControllerBot.recordTracelog msp.data', function () {
  this.timeout(30000);

  const mspData = () => ({
    config: { alarms: { apply: { default: { state: 'ready' } } } },
    alarmSummary: { create: 0, ignore: 551, review: 7 },
    targetlists: [{ id: 'TL-1', name: 'a' }],
    mobileAccess: { It8M_iUtwHnv5qrYWN1VyQ: { profileId: 'full_access' } },
    plan: 'business',
  });
  const appInfo = { eid: 'test-eid', appID: 'test-app', platform: 'msp', version: '2.12.0(1)' };
  const ids = [];
  let events;
  let originalEmit;

  const rawmsg = (id, list, item = 'msp.data') => ({
    id, mtype: 'set', target: '0.0.0.0', appInfo, data: { item, value: { list } }
  });

  // seed the precede record GuardianSensor would have written before setMspData
  const seedOrigin = async (id, origin) => {
    ids.push(id);
    await rclient.setAsync(Constants.REDIS_KEY_HISTORY_MSG_PREFIX + id, JSON.stringify({ origin }));
    await rclient.expireAsync(Constants.REDIS_KEY_HISTORY_MSG_PREFIX + id, 120);
  };

  const record = async (msg, code = 200) => {
    traced.length = 0; events = [];
    const bot = Object.create(ControllerBot.prototype);
    await bot.recordTracelog(msg, { code, message: code == 200 ? '' : 'redis write failed' });
    return { traced: traced.slice(), events };
  };

  before(() => {
    originalEmit = sem.emitEvent;
    sem.emitEvent = (event) => { events.push(event); };
  });

  after(async () => {
    sem.emitEvent = originalEmit;
    for (const id of ids) await rclient.unlinkAsync(Constants.REDIS_KEY_HISTORY_MSG_PREFIX + id);
  });

  it('logs a summary to Trace.log but hands the full payload to action:history', async () => {
    const id = 'tracelog-test-changed';
    const next = mspData(); next.alarmSummary = { create: 0, ignore: 552, review: 7 };
    await seedOrigin(id, mspData());
    const { traced, events } = await record(rawmsg(id, next));

    expect(traced).to.have.lengthOf(1);
    expect(traced[0].tracelog.action.value.changed).to.deep.equal(['alarmSummary']);
    expect(traced[0].tracelog.action.value.list).to.be.undefined;

    const emitted = events.filter(e => e.type === 'RecordAction');
    expect(emitted).to.have.lengthOf(1);
    // the whole reason for the split: action:history must still see everything
    expect(emitted[0].action.action.value.list).to.deep.equal(next);
    expect(emitted[0].action.origin).to.deep.equal(mspData());
  });

  it('skips Trace.log when the payload is unchanged, without disturbing action:history', async () => {
    const id = 'tracelog-test-unchanged';
    await seedOrigin(id, mspData());
    const { traced, events } = await record(rawmsg(id, mspData()));

    expect(traced).to.be.empty;
    const emitted = events.filter(e => e.type === 'RecordAction');
    expect(emitted).to.have.lengthOf(1);
    expect(emitted[0].action.action.value.list).to.deep.equal(mspData());
  });

  it('still records an unchanged payload when the set failed', async () => {
    const id = 'tracelog-test-failed';
    await seedOrigin(id, mspData());
    const { traced } = await record(rawmsg(id, mspData()), 500);

    expect(traced).to.have.lengthOf(1);
    expect(traced[0].tracelog.success).to.be.false;
    expect(traced[0].tracelog.error).to.equal('redis write failed');
    // a failed set is not summarized, the attempted payload is what matters
    expect(traced[0].tracelog.action.value.list).to.deep.equal(mspData());
  });

  it('leaves other items alone', async () => {
    const id = 'tracelog-test-other';
    const value = { policy: { block: 1 } };
    const { traced } = await record({
      id, mtype: 'set', target: '0.0.0.0', appInfo, data: { item: 'policy', value }
    });
    expect(traced).to.have.lengthOf(1);
    expect(traced[0].tracelog.action.value).to.deep.equal(value);
  });
});
