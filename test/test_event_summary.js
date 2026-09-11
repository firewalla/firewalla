/*    Copyright 2026 Firewalla LLC
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

let chai = require('chai');
let expect = chai.expect;

const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const Constants = require('../net2/Constants.js');
const sysManager = require('../net2/SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const EventSummarySensor = require('../sensor/EventSummarySensor.js');

// each sensor instance registers a MSG_EVENT_GENERATED listener, these tests build many of them
// and call _onEvent() directly rather than going through the bus
sem.setMaxListeners(0);

const LA = 'America/Los_Angeles';
const SH = 'Asia/Shanghai';

// expected values computed independently of moment, from python zoneinfo
const LA_SEP11_0300 = 1789120800;
const LA_SEP11_MIDNIGHT = 1789110000;
const SH_SEP11_0300 = 1789066800;
const SH_SEP11_MIDNIGHT = 1789056000;
const LA_SPRINGFWD_1000 = 1772989200;   // 2026-03-08, the 23-hour day
const LA_SPRINGFWD_MIDNIGHT = 1772956800;
const LA_FALLBACK_1000 = 1793556000;    // 2026-11-01, the 25-hour day
const LA_FALLBACK_MIDNIGHT = 1793516400;
const LA_SEP11_0345 = 1789123500;

// Redis-backed tests must anchor to the CURRENT local day. The sensor derives the bucket TTL as
// bucketTs + period + retention - now and skips the write when that is <= 0, so a hard-coded past
// date would silently stop persisting once it aged past the 7-day retention window.
function todayAt(offsetSec) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000) + offsetSec;
}

const TEST_KEY = 'event::test_summary';

function makeSensor(settings) {
  const sensor = new EventSummarySensor({ eventSummarySettings: settings || [] });
  // bypass the cloud fetch, exercise only the validation/merge half of loadConfig
  sensor.eventSummaryConfs = { eventSummarySettings: sensor._validateSettings(settings || []) };
  return sensor;
}

function stateEvent(ts, stateValue, labels, prevStateValue) {
  const e = {
    event_type: 'state',
    ts,                       // MILLISECONDS, as every producer emits
    state_type: 'test_state_change',
    state_key: 'k1',
    state_value: stateValue,
    labels: labels || {}
  };
  if (prevStateValue !== undefined) e.prev_state_value = prevStateValue;
  return e;
}

const SETTING = {
  period: 86400,
  key: TEST_KEY,
  filter: { and: [ { field: 'event_type', value: 'state' },
                   { field: 'state_type', value: 'test_state_change' } ] },
  labelKeys: ['mac']
};

async function cleanup() {
  const keys = await rclient.zrangeAsync(Constants.REDIS_KEY_EVENT_SUMMARY_INDEX, 0, -1);
  const mine = (keys || []).filter(k => k.includes(TEST_KEY));
  for (const k of mine) {
    await rclient.unlinkAsync(k);
    await rclient.zremAsync(Constants.REDIS_KEY_EVENT_SUMMARY_INDEX, k);
  }
}

async function readBucket(sensor, setting, bucketTs) {
  const raw = await rclient.getAsync(sensor._getBucketKey(setting, bucketTs));
  return raw && JSON.parse(raw);
}

describe('Test event summary period alignment', function() {
  let sensor;
  let savedTz;

  before(() => {
    sensor = makeSensor([SETTING]);
    savedTz = sysManager.timezone;
  });
  after(() => { sysManager.timezone = savedTz; });

  it('should align a daily bucket to local midnight', async () => {
    sysManager.timezone = LA;
    expect(sensor._periodStart(LA_SEP11_0300, 86400)).to.equal(LA_SEP11_MIDNIGHT);
    sysManager.timezone = SH;
    expect(sensor._periodStart(SH_SEP11_0300, 86400)).to.equal(SH_SEP11_MIDNIGHT);
  });

  it('should return a real epoch, not a timezone-shifted value', async () => {
    sysManager.timezone = LA;
    const ts = sensor._periodStart(LA_SEP11_0300, 86400);
    // 2026-09-11 00:00 PDT is 07:00 UTC the same day
    expect(new Date(ts * 1000).toISOString()).to.equal('2026-09-11T07:00:00.000Z');
  });

  it('should stay on midnight across DST transitions', async () => {
    sysManager.timezone = LA;
    // spring forward: the 23-hour day, local midnight exists
    expect(sensor._periodStart(LA_SPRINGFWD_1000, 86400)).to.equal(LA_SPRINGFWD_MIDNIGHT);
    // fall back: the 25-hour day
    expect(sensor._periodStart(LA_FALLBACK_1000, 86400)).to.equal(LA_FALLBACK_MIDNIGHT);
    // the bucket start is never in the future relative to the event
    expect(sensor._periodStart(LA_SPRINGFWD_1000, 86400)).to.be.at.most(LA_SPRINGFWD_1000);
    expect(sensor._periodStart(LA_FALLBACK_1000, 86400)).to.be.at.most(LA_FALLBACK_1000);
  });

  it('should keep a 25-hour DST day in a single daily bucket', async () => {
    sysManager.timezone = LA;
    // 2026-11-01 is 90000s long. Without clamping the slot index, 23:00-24:00 local lands
    // 86400s past midnight and opens a SECOND bucket for the same local day
    const dayStart = LA_FALLBACK_MIDNIGHT;
    for (const offset of [0, 82800, 86400, 88200, 89999]) {
      expect(sensor._periodStart(dayStart + offset, 86400)).to.equal(dayStart);
    }
    // the next day still starts its own bucket
    expect(sensor._periodStart(dayStart + 90000, 86400)).to.equal(dayStart + 90000);
  });

  it('should absorb the extra DST hour into the last sub-day slot', async () => {
    sysManager.timezone = LA;
    const dayStart = LA_FALLBACK_MIDNIGHT;
    const lastSlot = dayStart + 7 * 10800; // 8 slots of 3h per local day
    // the 25th hour extends the final slot rather than creating a 9th
    expect(sensor._periodStart(dayStart + 7 * 10800, 10800)).to.equal(lastSlot);
    expect(sensor._periodStart(dayStart + 89999, 10800)).to.equal(lastSlot);
    expect(sensor._periodStart(dayStart + 90000, 10800)).to.equal(dayStart + 90000);
  });

  it('should subdivide the local day for a sub-day period', async () => {
    sysManager.timezone = LA;
    expect(sensor._periodStart(LA_SEP11_0345, 3600)).to.equal(LA_SEP11_0300);
  });

  it('should keep the short trailing slot for a period that does not divide a day', async () => {
    sysManager.timezone = LA;
    // 7000 leaves a 2400s trailing slot (12 full slots + remainder). Clamping with floor() would
    // merge that remainder into the 11th slot instead of leaving it as its own
    const dayStart = LA_SEP11_MIDNIGHT;
    expect(sensor._periodStart(dayStart + 84000, 7000)).to.equal(dayStart + 84000);
    expect(sensor._periodStart(dayStart + 85000, 7000)).to.equal(dayStart + 84000);
    expect(sensor._periodStart(dayStart + 86399, 7000)).to.equal(dayStart + 84000);
    // and the slot before it is still its own
    expect(sensor._periodStart(dayStart + 77000, 7000)).to.equal(dayStart + 77000);
  });

  it('should fall back to UTC when timezone is unset', async () => {
    sysManager.timezone = null; // getTimezone() returns "UTC"
    expect(sensor._periodStart(LA_SEP11_0300, 86400)).to.equal(
      Math.floor(LA_SEP11_0300 / 86400) * 86400);
  });
});

describe('Test event summary startup', function() {
  it('should apply local settings before any cloud fetch', async () => {
    // run() only reaches loadConfig() after a cloud round trip, but EventRequestHandler is already
    // emitting by then - a sensor that has only been constructed must already match
    const sensor = new EventSummarySensor({ eventSummarySettings: [SETTING] });
    expect(sensor.eventSummaryConfs.eventSummarySettings).to.have.lengthOf(1);
    expect(sensor.eventSummaryConfs.eventSummarySettings[0].key).to.equal(TEST_KEY);
  });

  it('should tolerate construction with no config', async () => {
    expect(new EventSummarySensor({}).eventSummaryConfs.eventSummarySettings).to.be.empty;
    expect(new EventSummarySensor().eventSummaryConfs.eventSummarySettings).to.be.empty;
  });
});

describe('Test event summary settings validation', function() {
  it('should drop settings that cannot match anything', async () => {
    const sensor = makeSensor([]);
    // matchFilter() returns false for an empty node, such a setting would silently never match
    expect(sensor._validateSettings([{ key: 'k', labelKeys: ['mac'] }])).to.be.empty;
    expect(sensor._validateSettings([{ key: 'k', filter: { field: 'a', value: 1 } }])).to.be.empty;
    expect(sensor._validateSettings([{ filter: { field: 'a', value: 1 }, labelKeys: ['mac'] }])).to.be.empty;
  });

  it('should fall back to a daily period when period does not tile a local day', async () => {
    const sensor = makeSensor([]);
    const base = { key: 'k', filter: { field: 'a', value: 1 }, labelKeys: ['mac'] };
    // 7000 is not a divisor of 86400, the last bucket of each day would be short
    expect(sensor._validateSettings([Object.assign({}, base, { period: 7000 })])[0].period).to.equal(86400);
    expect(sensor._validateSettings([Object.assign({}, base, { period: 0 })])[0].period).to.equal(86400);
    expect(sensor._validateSettings([Object.assign({}, base, { period: 90000 })])[0].period).to.equal(86400);
    expect(sensor._validateSettings([base])[0].period).to.equal(86400);
    // valid divisors are kept
    expect(sensor._validateSettings([Object.assign({}, base, { period: 3600 })])[0].period).to.equal(3600);
    expect(sensor._validateSettings([Object.assign({}, base, { period: 7200 })])[0].period).to.equal(7200);
  });
});

describe('Test event summary record upsert', function() {
  let sensor;
  let savedTz;
  let bucketTs;
  let anchor;
  const MAC = 'aa:bb:cc:dd:ee:ff';

  beforeEach(async () => {
    savedTz = sysManager.timezone;
    sysManager.timezone = LA;
    sensor = makeSensor([SETTING]);
    anchor = todayAt(3 * 3600); // 03:00 local today
    bucketTs = sensor._periodStart(anchor, 86400);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    sysManager.timezone = savedTz;
  });

  it('should bucket by event ts in milliseconds', async () => {
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }));
    // treating ts as seconds would land this in 1970
    const bucket = await readBucket(sensor, SETTING, bucketTs);
    expect(bucket).to.not.be.null;
    expect(bucket.ts).to.equal(bucketTs);
    expect(bucket.ts).to.equal(sensor._periodStart(anchor, 86400));
    expect(bucket.du).to.equal(86400);
    expect(bucket.key).to.equal(TEST_KEY);
  });

  it('should record prev_state as null for an initial no_error event', async () => {
    // a no_error event's very first sighting has no prev_state_value at all
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC, no_error: true }));
    const bucket = await readBucket(sensor, SETTING, bucketTs);
    const rec = bucket.records[0];
    expect(rec).to.have.property('prev_state');   // present, not dropped by JSON.stringify
    expect(rec.prev_state).to.be.null;
    expect(rec.end_state).to.equal(1);
    expect(rec.seen_states).to.deep.equal([1]);
    expect(rec.cnt).to.equal(1);
    expect(rec.mac).to.equal(MAC);
  });

  it('should keep prev_state and move end_state across a transition', async () => {
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    await sensor._onEvent(stateEvent((anchor + 60) * 1000, 2, { mac: MAC }, 1));
    const rec = (await readBucket(sensor, SETTING, bucketTs)).records[0];
    expect(rec.prev_state).to.equal(0);   // from the FIRST event
    expect(rec.end_state).to.equal(2);    // from the LAST event
    expect(rec.seen_states).to.deep.equal([1, 2]);
    expect(rec.cnt).to.equal(2);
  });

  it('should not let an out-of-order arrival clobber end_state', async () => {
    // emission order is not ts order: ap_* events go through a bee-queue while others run inline
    await sensor._onEvent(stateEvent((anchor + 60) * 1000, 2, { mac: MAC }, 1));
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    const rec = (await readBucket(sensor, SETTING, bucketTs)).records[0];
    expect(rec.end_state).to.equal(2);    // still the latest BY TS
    expect(rec.prev_state).to.equal(0);   // taken from the earliest BY TS
    expect(rec.cnt).to.equal(2);
  });

  it('should order by full millisecond precision within the same second', async () => {
    // both events fall in the same second - truncating to seconds would make them tie and let the
    // older one, arriving second, overwrite end_state
    const base = anchor * 1000;
    await sensor._onEvent(stateEvent(base + 900, 2, { mac: MAC }, 1)); // newer, arrives first
    await sensor._onEvent(stateEvent(base + 100, 1, { mac: MAC }, 0)); // older, arrives second
    const rec = (await readBucket(sensor, SETTING, bucketTs)).records[0];
    expect(rec.end_state).to.equal(2);   // still the latest BY TS
    expect(rec.prev_state).to.equal(0);  // taken from the earliest BY TS
    expect(rec.cnt).to.equal(2);
  });

  it('should count repeats in cnt without duplicating seen_states', async () => {
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    await sensor._onEvent(stateEvent((anchor + 60) * 1000, 2, { mac: MAC }, 1));
    await sensor._onEvent(stateEvent((anchor + 120) * 1000, 1, { mac: MAC }, 2));
    const rec = (await readBucket(sensor, SETTING, bucketTs)).records[0];
    expect(rec.seen_states).to.deep.equal([1, 2]);
    expect(rec.cnt).to.equal(3);
    expect(rec.cnt).to.be.at.least(rec.seen_states.length);
  });

  it('should group by labels, not by top-level event fields', async () => {
    const other = '11:22:33:44:55:66';
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    await sensor._onEvent(stateEvent(anchor * 1000, 5, { mac: other }, 4));
    const records = (await readBucket(sensor, SETTING, bucketTs)).records;
    expect(records).to.have.lengthOf(2);
    expect(records.map(r => r.mac).sort()).to.deep.equal([other, MAC].sort());
  });

  it('should keep a missing label distinguishable from a real value', async () => {
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    await sensor._onEvent(stateEvent(anchor * 1000, 3, {}, 2)); // no mac label
    const records = (await readBucket(sensor, SETTING, bucketTs)).records;
    expect(records).to.have.lengthOf(2);
    const anon = records.find(r => r.mac === null);
    expect(anon).to.not.be.undefined;      // the field survives rather than being dropped
    expect(anon.end_state).to.equal(3);
  });

  it('should not resolve labelKeys from top-level fields', async () => {
    const sensor2 = makeSensor([Object.assign({}, SETTING, { labelKeys: ['state_key'] })]);
    await sensor2._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    const setting2 = sensor2.eventSummaryConfs.eventSummarySettings[0];
    const rec = (await readBucket(sensor2, setting2, bucketTs)).records[0];
    expect(rec.state_key).to.be.null;      // state_key is top-level, labelKeys read labels only
  });

  it('should not match a filter on a label', async () => {
    const sensor2 = makeSensor([Object.assign({}, SETTING,
      { filter: { field: 'mac', value: MAC } })]);
    await sensor2._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    const setting2 = sensor2.eventSummaryConfs.eventSummarySettings[0];
    expect(await readBucket(sensor2, setting2, bucketTs)).to.be.null;
  });

  it('should ignore action events', async () => {
    const e = stateEvent(anchor * 1000, 1, { mac: MAC }, 0);
    e.event_type = 'action';
    await sensor._onEvent(e);
    expect(await readBucket(sensor, SETTING, bucketTs)).to.be.null;
  });

  it('should ignore an event with an unusable ts', async () => {
    await sensor._onEvent(stateEvent('not-a-number', 1, { mac: MAC }, 0));
    const keys = await rclient.zrangeAsync(Constants.REDIS_KEY_EVENT_SUMMARY_INDEX, 0, -1);
    expect((keys || []).filter(k => k.includes(TEST_KEY))).to.be.empty;
  });

  it('should index the bucket and set a ttl that does not grow on rewrite', async () => {
    await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: MAC }, 0));
    const key = sensor._getBucketKey(SETTING, bucketTs);
    const score = await rclient.zscoreAsync(Constants.REDIS_KEY_EVENT_SUMMARY_INDEX, key);
    expect(Number(score)).to.equal(bucketTs);
    const ttl1 = await rclient.ttlAsync(key);
    await sensor._onEvent(stateEvent((anchor + 60) * 1000, 2, { mac: MAC }, 1));
    const ttl2 = await rclient.ttlAsync(key);
    // ttl is pinned to the bucket horizon, a flat EX would renew it on every write
    expect(ttl2).to.be.at.most(ttl1);
  });
});

describe('Test event summary caps', function() {
  let sensor;
  let savedTz;
  let bucketTs;
  let anchor;

  beforeEach(async () => {
    savedTz = sysManager.timezone;
    sysManager.timezone = LA;
    sensor = makeSensor([SETTING]);
    anchor = todayAt(3 * 3600); // 03:00 local today
    bucketTs = sensor._periodStart(anchor, 86400);
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
    sysManager.timezone = savedTz;
  });

  it('should cap distinct records per bucket', async function() {
    this.timeout(60000);
    for (let i = 0; i < 405; i++)
      await sensor._onEvent(stateEvent(anchor * 1000, 1, { mac: `mac-${i}` }, 0));
    const records = (await readBucket(sensor, SETTING, bucketTs)).records;
    expect(records).to.have.lengthOf(400);
  });

  it('should cap seen_states while cnt keeps rising', async function() {
    this.timeout(60000);
    const MAC = 'aa:bb:cc:dd:ee:ff';
    for (let i = 0; i < 110; i++)
      await sensor._onEvent(stateEvent((anchor + i) * 1000, i, { mac: MAC }, i - 1));
    const rec = (await readBucket(sensor, SETTING, bucketTs)).records[0];
    expect(rec.seen_states).to.have.lengthOf(100);
    expect(rec.cnt).to.equal(110);   // a saturated record is still visibly hot
  });
});
