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

const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

const _ = require('lodash');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const fc = require('../net2/config.js');
const sysManager = require('../net2/SysManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

const am2 = new AlarmManager2();

const DAY = 24 * 60 * 60;
const WINDOW_DAYS = 30;

const ALARM_ACTIVE = 'alarm_active';
const ALARM_PENDING = 'alarm_pending';
const ALARM_ARCHIVE = 'alarm_archive';

// aids dedicated to this test, keep them away from real alarms on box
const AID_RECENT = '9900001';   // generated a minute ago
const AID_IN = '9900002';       // right after the begin of the window
const AID_OUT = '9900003';      // right before the begin of the window
const TEST_AIDS = [AID_RECENT, AID_IN, AID_OUT];

// DST at midnight (Santiago, Havana), 30 min DST (Lord Howe), 45 min offset (Chatham)
const TIMEZONES = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai', 'Europe/Berlin',
  'Australia/Lord_Howe', 'America/Santiago', 'America/Havana', 'Pacific/Chatham'];

// seeds sit a full day away from the edge of the window, the begin only ever moves later, so a
// midnight rollover in the middle of a test cannot flip which side of the window a seed is on
const IN_OFFSET = 25 * 3600;
const OUT_OFFSET = -3600;

// how long an alarm key is kept, see saveAlarm in AlarmManager2, the slack there covers the
// widest the calendar window can get on the day the clock falls back
const ALARM_EXPIRE_SLACK = 2 * 60 * 60;
function alarmRetention() {
  const expires = _.get(fc.getConfig(), 'sensors.OldDataCleanSensor.alarm.expires') || WINDOW_DAYS * DAY;
  return expires + ALARM_EXPIRE_SLACK;
}

async function seedAlarm(aid, indexKey, score, alarmTs = score) {
  const raw = {
    aid, type: 'ALARM_SUBNET', device: 'Alarm Window Test', state: 'active',
    alarmTimestamp: alarmTs, timestamp: alarmTs, message: 'alarm window test'
  };
  await rclient.hsetAsync('_alarm:' + aid, Object.entries(raw).flat());
  await rclient.zaddAsync(indexKey, score, aid);
}

async function cleanupSeeded() {
  for (const aid of TEST_AIDS) {
    await rclient.zremAsync(ALARM_ACTIVE, aid);
    await rclient.zremAsync(ALARM_PENDING, aid);
    await rclient.zremAsync(ALARM_ARCHIVE, aid);
    await rclient.unlinkAsync('_alarm:' + aid);
    await rclient.unlinkAsync('_alarmDetail:' + aid);
  }
}

describe('alarm last-30-days window in calendar date', function () {
  this.timeout(30000);

  // ---------------------------------------------------------------------------
  // 1. time math: getAlarmWindowBeginTs
  // ---------------------------------------------------------------------------
  describe('time math', () => {
    let origGetTimezone;

    before(() => { origGetTimezone = sysManager.getTimezone });
    after(() => { sysManager.getTimezone = origGetTimezone });

    it('should begin at midnight of the calendar date 29 days ago', () => {
      // fixed moments, one per timezone, so that nothing depends on when the test runs
      const cases = [
        ['UTC', '2026-07-27T00:00:00', '2026-06-28T00:00:00'],
        ['UTC', '2026-07-27T23:59:59', '2026-06-28T00:00:00'],
        ['America/Los_Angeles', '2026-07-27T12:34:56', '2026-06-28T00:00:00'],
        ['Asia/Shanghai', '2026-01-05T08:00:00', '2025-12-07T00:00:00'],
        ['Europe/Berlin', '2026-03-29T12:00:00', '2026-02-28T00:00:00'], // spring forward today
        ['Australia/Lord_Howe', '2026-04-05T12:00:00', '2026-03-07T00:00:00'],
        ['America/Santiago', '2026-09-06T12:00:00', '2026-08-08T00:00:00'], // DST starts at midnight
        ['America/Havana', '2026-11-01T12:00:00', '2026-10-03T00:00:00'],   // clock falls back today
        ['Pacific/Chatham', '2026-09-27T12:00:00', '2026-08-29T00:00:00'],
      ];
      for (const [tz, nowStr, expectStr] of cases) {
        sysManager.getTimezone = () => tz;
        const now = moment.tz(nowStr, tz).unix();
        const label = `${tz} ${nowStr}`;
        expect(am2.getAlarmWindowBeginTs(WINDOW_DAYS, now), label)
          .to.be.equal(moment.tz(expectStr, tz).unix());
        // 30 calendar days counting the day of now
        expect(moment.unix(now).tz(tz).startOf('day')
          .diff(moment.tz(expectStr, tz), 'days') + 1, label).to.be.equal(WINDOW_DAYS);
      }
    });

    it('should be the same expression MSP frontend uses for last-30-days', () => {
      // dayjs.tz(now, boxTimezone).subtract(29, 'day').startOf('day'), including the case the
      // MSP DST test pins down: now 2024-03-10 12:00 in LA gives 2024-02-10
      for (const tz of TIMEZONES) {
        sysManager.getTimezone = () => tz;
        for (const nowStr of ['2024-03-10T12:00:00', '2026-11-01T00:30:00', '2026-06-15T23:30:00']) {
          const now = moment.tz(nowStr, tz).unix();
          expect(am2.getAlarmWindowBeginTs(WINDOW_DAYS, now), `${tz} ${nowStr}`)
            .to.be.equal(moment.unix(now).tz(tz).subtract(29, 'day').startOf('day').unix());
        }
      }
      sysManager.getTimezone = () => 'America/Los_Angeles';
      expect(am2.getAlarmWindowBeginTs(WINDOW_DAYS, moment.tz('2024-03-10T12:00:00', 'America/Los_Angeles').unix()))
        .to.be.equal(moment.tz('2024-02-10T00:00:00', 'America/Los_Angeles').unix());
    });

    it('should move by exactly one day when the clock passes midnight', () => {
      // the boundary the box and MSP have to agree on
      for (const tz of TIMEZONES) {
        sysManager.getTimezone = () => tz;
        for (const dateStr of ['2026-07-27', '2026-11-02', '2026-03-30']) {
          const midnight = moment.tz(dateStr, tz).startOf('day');
          const before = am2.getAlarmWindowBeginTs(WINDOW_DAYS, midnight.unix() - 1);
          const after = am2.getAlarmWindowBeginTs(WINDOW_DAYS, midnight.unix());
          const label = `${tz} ${dateStr}`;
          expect(after, label).to.be.above(before);
          expect(moment.unix(after).tz(tz).diff(moment.unix(before).tz(tz), 'days'), label).to.be.equal(1);
        }
      }
    });

    it('should be narrower than the absolute 30-day duration box used to keep', () => {
      // MSP window begins at midnight of D-29, which is later than now - 30*24h except right
      // after the clock falls back, this is the alignment gap the change is about
      for (const tz of TIMEZONES) {
        sysManager.getTimezone = () => tz;
        for (const nowStr of ['2026-07-27T00:00:00', '2026-07-27T12:00:00', '2026-07-27T23:59:59']) {
          const now = moment.tz(nowStr, tz).unix();
          const begin = am2.getAlarmWindowBeginTs(WINDOW_DAYS, now);
          const label = `${tz} ${nowStr}`;
          expect(begin, label).to.be.at.least(now - WINDOW_DAYS * DAY);
          expect(begin, label).to.be.at.most(now - (WINDOW_DAYS - 1) * DAY);
        }
      }
    });

    it('should fall back to system local time on unknown timezone', () => {
      const now = moment('2026-07-27T12:34:56').unix();
      sysManager.getTimezone = () => 'not/a-timezone';
      const begin = am2.getAlarmWindowBeginTs(WINDOW_DAYS, now);
      expect(begin).to.be.equal(moment.unix(now).subtract(WINDOW_DAYS - 1, 'days').startOf('day').unix());
      sysManager.getTimezone = () => undefined;
      expect(am2.getAlarmWindowBeginTs(WINDOW_DAYS, now)).to.be.equal(begin);
    });

    it('should default to the current time when no timestamp is passed', () => {
      sysManager.getTimezone = () => 'UTC';
      const before = am2.getAlarmWindowBeginTs();
      const sampled = am2.getAlarmWindowBeginTs(WINDOW_DAYS, Date.now() / 1000);
      const after = am2.getAlarmWindowBeginTs();
      // sampled between the two, they differ only if the day rolls over in between
      expect(sampled).to.be.at.least(before);
      expect(sampled).to.be.at.most(after);
    });

    it('should stay within the retention of the alarm key on any day of a year', () => {
      // alarm keys are still expired by an absolute duration since they are saved, the window
      // has to stay inside that duration, otherwise a counted alarm could have no data behind it.
      // on the day the clock falls back the window spans one DST offset more than 30*24h, in the
      // hour that follows a counted alarm may already be gone, which is the same kind of leftover
      // as an index entry whose alarm expired
      for (const tz of TIMEZONES) {
        sysManager.getTimezone = () => tz;
        for (let d = 0; d < 366; d++) {
          for (const h of ['00:00', '00:30', '12:00', '23:30']) {
            const now = moment.tz('2026-01-01 ' + h, tz).add(d, 'days').unix();
            const label = `${tz} ${moment.unix(now).tz(tz).format()}`;
            expect(now - am2.getAlarmWindowBeginTs(WINDOW_DAYS, now), label)
              .to.be.at.most(alarmRetention());
          }
        }
      }
    });

    it('should still be covered by the retention on the day the clock falls back', () => {
      // this is the day the window is at its widest: the wall clock repeats an hour, so the
      // window spans 30 days plus one DST offset, more than the 30*24h box keeps alarms for
      // late in the day, so that 29 days + the time of day + the repeated hour go past 30 days
      const cases = [
        ['America/Los_Angeles', '2026-11-01T23:30:00', 3600],
        ['America/Havana', '2026-11-01T23:30:00', 3600],
        ['Europe/Berlin', '2026-10-25T23:30:00', 3600],
        ['Australia/Lord_Howe', '2026-04-05T23:45:00', 1800], // 30 min DST
      ];
      for (const [tz, nowStr, dstOffset] of cases) {
        sysManager.getTimezone = () => tz;
        const now = moment.tz(nowStr, tz).unix();
        const span = now - am2.getAlarmWindowBeginTs(WINDOW_DAYS, now);
        const label = `${tz} ${nowStr}`;
        // the window really does grow beyond the plain 30 days here
        expect(span, label).to.be.above(WINDOW_DAYS * DAY);
        expect(span, label).to.be.at.most(WINDOW_DAYS * DAY + dstOffset);
        // and the retention of the alarm key still covers it
        expect(span, label).to.be.at.most(alarmRetention());
      }
    });

    it('should honor a custom number of days', () => {
      const tz = 'Asia/Shanghai';
      sysManager.getTimezone = () => tz;
      const now = moment.tz('2026-07-27T12:00:00', tz).unix();
      expect(am2.getAlarmWindowBeginTs(7, now)).to.be.equal(moment.tz('2026-07-21T00:00:00', tz).unix());
      expect(am2.getAlarmWindowBeginTs(1, now)).to.be.equal(moment.tz('2026-07-27T00:00:00', tz).unix());
      expect(am2.getAlarmWindowBeginTs(7, now)).to.be.above(am2.getAlarmWindowBeginTs(WINDOW_DAYS, now));
    });
  });

  // ---------------------------------------------------------------------------
  // 2. alarm counts in init data
  // ---------------------------------------------------------------------------
  describe('alarm counts', () => {
    let begin;

    beforeEach(async () => {
      begin = am2.getAlarmWindowBeginTs();
      await cleanupSeeded();
    });

    afterEach(async () => { await cleanupSeeded() });

    it('should count only alarms within the window', async () => {
      for (const [key, countFunc] of [
        [ALARM_ACTIVE, beginTs => am2.getActiveAlarmCount(beginTs)],
        [ALARM_PENDING, beginTs => am2.getPendingAlarmCount(beginTs)],
        [ALARM_ARCHIVE, beginTs => am2.numberOfArchivedAlarms(beginTs)],
      ]) {
        const base = await countFunc(begin);
        await seedAlarm(AID_IN, key, begin + IN_OFFSET);
        await seedAlarm(AID_OUT, key, begin + OUT_OFFSET);
        // counting from the captured begin is deterministic, and the default has to agree with it
        expect(await countFunc(begin), key).to.be.equal(base + 1);
        expect(await countFunc(), key).to.be.equal(base + 1);
        await cleanupSeeded();
      }
    });

    it('should accept an explicit begin timestamp', async () => {
      const narrowed = begin + IN_OFFSET + 3600;
      const baseAll = await am2.getActiveAlarmCount(0);
      const baseNarrowed = await am2.getActiveAlarmCount(narrowed);
      await seedAlarm(AID_IN, ALARM_ACTIVE, begin + IN_OFFSET);
      await seedAlarm(AID_OUT, ALARM_ACTIVE, begin + OUT_OFFSET);
      // both are counted when the window is opened up
      expect(await am2.getActiveAlarmCount(0)).to.be.equal(baseAll + 2);
      // neither is counted when the begin is moved after both of them
      expect(await am2.getActiveAlarmCount(narrowed)).to.be.equal(baseNarrowed);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. loadActiveAlarmsAsync ts2
  // ---------------------------------------------------------------------------
  describe('get alarms with ts2', () => {
    let begin, now;

    beforeEach(async () => {
      now = Date.now() / 1000;
      begin = am2.getAlarmWindowBeginTs();
      await cleanupSeeded();
      await seedAlarm(AID_RECENT, ALARM_ACTIVE, now - 60);
      await seedAlarm(AID_IN, ALARM_ACTIVE, begin + IN_OFFSET);
      await seedAlarm(AID_OUT, ALARM_ACTIVE, begin + OUT_OFFSET);
    });

    afterEach(async () => { await cleanupSeeded() });

    it('should exclude alarms out of the window by default', async () => {
      const aids = (await am2.loadActiveAlarmsAsync({ count: 5000 })).map(a => a.aid);
      expect(aids).to.include(AID_RECENT);
      expect(aids).to.include(AID_IN);
      expect(aids).to.not.include(AID_OUT);
    });

    it('should use ts2 as the begin timestamp of the query', async () => {
      const aids = (await am2.loadActiveAlarmsAsync({ count: 5000, ts2: now - 3600 })).map(a => a.aid);
      expect(aids).to.include(AID_RECENT);
      expect(aids).to.not.include(AID_IN);
      expect(aids).to.not.include(AID_OUT);
    });

    it('should use ts2 as the end timestamp when asc is true', async () => {
      const aids = (await am2.loadActiveAlarmsAsync({
        count: 5000, asc: true, ts: begin + OUT_OFFSET - 3600, ts2: begin
      })).map(a => a.aid);
      expect(aids).to.include(AID_OUT);
      expect(aids).to.not.include(AID_IN);
      expect(aids).to.not.include(AID_RECENT);
    });

    it('should return everything with ts2 = 0 and fall back to default on invalid ts2', async () => {
      const all = (await am2.loadActiveAlarmsAsync({ count: 5000, ts2: 0 })).map(a => a.aid);
      expect(all).to.include(AID_OUT);

      for (const ts2 of ['not-a-number', null]) {
        const aids = (await am2.loadActiveAlarmsAsync({ count: 5000, ts2 })).map(a => a.aid);
        expect(aids, String(ts2)).to.not.include(AID_OUT);
        expect(aids, String(ts2)).to.include(AID_IN);
      }
    });

    it('should keep count as the limit of the query', async () => {
      const alarms = await am2.loadActiveAlarmsAsync({ count: 1 });
      expect(alarms.length).to.be.at.most(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. pendingAlarms / archivedAlarms beginTs
  // ---------------------------------------------------------------------------
  describe('get pending and archived alarms with beginTs', () => {
    let begin;

    beforeEach(async () => {
      begin = am2.getAlarmWindowBeginTs();
      await cleanupSeeded();
    });

    afterEach(async () => { await cleanupSeeded() });

    it('should default to the begin of the window', async () => {
      await seedAlarm(AID_IN, ALARM_PENDING, begin + IN_OFFSET);
      await seedAlarm(AID_OUT, ALARM_PENDING, begin + OUT_OFFSET);
      const aids = (await am2.loadPendingAlarms({ limit: 5000 })).map(a => a.aid);
      expect(aids).to.include(AID_IN);
      expect(aids).to.not.include(AID_OUT);

      await cleanupSeeded();
      await seedAlarm(AID_IN, ALARM_ARCHIVE, begin + IN_OFFSET);
      await seedAlarm(AID_OUT, ALARM_ARCHIVE, begin + OUT_OFFSET);
      const archivedAids = (await am2.loadArchivedAlarms({ limit: 5000 })).map(a => a.aid);
      expect(archivedAids).to.include(AID_IN);
      expect(archivedAids).to.not.include(AID_OUT);
    });

    it('should honor an explicit beginTs, including 0', async () => {
      await seedAlarm(AID_IN, ALARM_PENDING, begin + IN_OFFSET);
      await seedAlarm(AID_OUT, ALARM_PENDING, begin + OUT_OFFSET);
      const all = (await am2.loadPendingAlarms({ limit: 5000, beginTs: 0 })).map(a => a.aid);
      expect(all).to.include(AID_OUT);
      const narrowed = (await am2.loadPendingAlarms({
        limit: 5000, beginTs: begin + IN_OFFSET + 3600
      })).map(a => a.aid);
      expect(narrowed).to.not.include(AID_IN);
    });

    it('should keep offset and limit working', async () => {
      await seedAlarm(AID_RECENT, ALARM_ARCHIVE, Date.now() / 1000);
      await seedAlarm(AID_IN, ALARM_ARCHIVE, begin + IN_OFFSET);
      const first = await am2.loadArchivedAlarms({ limit: 1 });
      const second = await am2.loadArchivedAlarms({ limit: 1, offset: 1 });
      expect(first.length).to.be.equal(1);
      expect(second.length).to.be.equal(1);
      expect(first[0].aid).to.be.not.equal(second[0].aid);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. index cache query path
  // ---------------------------------------------------------------------------
  describe('index cache query', () => {
    // the cache query is pure, run it on a fixed timeline
    const now = moment.tz('2026-07-27T12:00:00', 'UTC').unix();
    const begin = am2.getAlarmWindowBeginTs(WINDOW_DAYS, now);
    const entries = {
      [AID_RECENT]: { type: 'ALARM_SUBNET', aid: AID_RECENT, state: 'active', ts: now - 60 },
      [AID_IN]: { type: 'ALARM_SUBNET', aid: AID_IN, state: 'active', ts: begin + 3600 },
      [AID_OUT]: { type: 'ALARM_SUBNET', aid: AID_OUT, state: 'active', ts: begin - 3600 },
    };

    before(async () => { await am2.indexCache.set('ALARM_SUBNET', entries) });
    after(() => { am2.indexCache.reset() });

    it('should apply ts2 as the begin timestamp in descending query', () => {
      const ids = am2._queryCachedAlarmIds(5000, now + 1, false, 'active', { types: ['ALARM_SUBNET'] }, begin);
      expect(ids).to.include(AID_RECENT);
      expect(ids).to.include(AID_IN);
      expect(ids).to.not.include(AID_OUT);
    });

    it('should apply ts2 as the end timestamp in ascending query', () => {
      const ids = am2._queryCachedAlarmIds(5000, begin - 7200, true, 'active', { types: ['ALARM_SUBNET'] }, begin + 1800);
      expect(ids).to.include(AID_OUT);
      expect(ids).to.not.include(AID_IN);
      expect(ids).to.not.include(AID_RECENT);
    });

  });

  // ---------------------------------------------------------------------------
  // 6. retention still covers the window
  // ---------------------------------------------------------------------------
  describe('alarm retention', () => {
    const savedAids = [];

    afterEach(async () => {
      while (savedAids.length) await am2.removeAlarmAsync(savedAids.pop());
    });

    it('should keep an alarm at least as long as it stays in the window', async () => {
      // alarms are expired by an absolute duration since they are saved, that duration has to
      // cover the whole calendar window, otherwise a counted alarm could have no data behind it.
      // this breaks if OldDataCleanSensor.alarm.expires drops below 30 days
      const alarm = am2._genAlarm({ type: 'subnet', device: 'Alarm Window Test' });
      alarm['e.test.data'] = 'extended';
      const aid = await am2.saveAlarm(alarm);
      savedAids.push(aid);

      const nowTs = Date.now() / 1000;
      const ttl = await rclient.ttlAsync('_alarm:' + aid);
      const windowSpan = Math.ceil(nowTs - am2.getAlarmWindowBeginTs(WINDOW_DAYS, nowTs));
      expect(windowSpan).to.be.at.most(alarmRetention());
      expect(ttl).to.be.at.least(windowSpan);

      const detailTtl = await rclient.ttlAsync('_alarmDetail:' + aid);
      expect(detailTtl).to.be.closeTo(ttl, 2);
    });
  });
});
