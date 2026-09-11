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
'use strict';
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;
const _ = require('lodash');
const CronJob = require('cron').CronJob;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');
const bone = require('../lib/Bone.js');
const SysManager = require('../net2/SysManager.js');
const { matchFilter } = require('./BlockStatsFilter.js');
const AsyncLock = require('../vendor_lib/async-lock');
const { localSlotStart, tilesLocalDay } = require('../util/TimeSlot.js');

const DEFAULT_PERIOD = 86400; // 1 day, used when "period" isn't configured or is invalid
const RETENTION_SECS = 86400 * 7; // 7 days
const MAX_RECORDS_PER_KEY = 400; // cap on distinct records per key per bucket, to bound redis payload size
const MAX_SEEN_STATES = 100; // cap on distinct state values tracked per record

/*
 * EventSummarySensor folds generated state events into per-period, per-key buckets.
 *
 * For every configured setting, an event matching "filter" is grouped into a record keyed by
 * "labelKeys", and the record tracks the state the group started in, the state it ended in, every
 * state it passed through, and how many events were folded in.
 *
 * Buckets are aligned to LOCAL midnight, so a "day" means the user's day.
 *
 * NOTE: "filter" matches the event's TOP-LEVEL fields (event_type, state_type, state_key,
 * state_value, ...) while "labelKeys" are read from event.labels. The two halves of a setting
 * address different objects on purpose - the event is not flattened.
 */
class EventSummarySensor extends Sensor {
  constructor(config) {
    super(config);
    // seed from the local default synchronously - run() only reaches loadConfig() after a cloud
    // round trip, and EventRequestHandler is already emitting by then, so leaving this empty would
    // silently drop every transition in that window
    this.eventSummaryConfs = {
      eventSummarySettings: this._validateSettings((config && config.eventSummarySettings) || [])
    };
    this.lock = new AsyncLock({ maxPending: 10000 }); // vendored default of 1000 is too low for a burst on one key
    sem.on(Message.MSG_EVENT_GENERATED, event =>
      this._onEvent(event && event.event).catch(err => log.error('Failed to summarize event', err.message)));
  }

  async run() {
    await this.loadConfig(true);
    await this.scheduleUpdateConfigCronJob();

    sclient.on("message", async (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info("System timezone is reloaded, will reschedule update config cron job ...");
        await this.scheduleUpdateConfigCronJob();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
  }

  async scheduleUpdateConfigCronJob() {
    if (this.reloadJob)
      this.reloadJob.stop();
    if (this.reloadTimeout)
      clearTimeout(this.reloadTimeout);
    const tz = SysManager.getTimezone();
    this.reloadJob = new CronJob("30 23 * * *", async () => { // pull cloud config once every day, the request is sent between 23:30 to 00:00 to avoid calling cloud at the same time
      const delayMins = Math.random() * 30;
      this.reloadTimeout = setTimeout(async () => {
        await this.loadConfig(true).catch((err) => {
          log.error(`Failed to load event summary cloud config`, err.message);
        });
      }, delayMins * 60 * 1000);
    }, () => { }, true, tz);
  }

  // SensorLoader pushes a new config on "config:updated", refresh the effective settings right away
  // instead of waiting for the nightly cron or a restart
  async onConfigChange(oldConfig) {
    await this.loadConfig(false).catch((err) => {
      log.error(`Failed to reload event summary config on config change`, err.message);
    });
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load event summary config from cloud`, err.message);
    });
    // eventSummarySettings is an array of objects, _.merge on arrays merges by index rather than
    // concatenating/keying by "key", so the cloud config (when present) fully replaces the local
    // default array rather than being deep-merged with it
    const cloudSettings = this.cloudConfig && this.cloudConfig.eventSummarySettings;
    const localSettings = this.config && this.config.eventSummarySettings;
    const settings = (!_.isEmpty(cloudSettings) ? cloudSettings : localSettings) || [];
    this.eventSummaryConfs = { eventSummarySettings: this._validateSettings(settings) };
  }

  async loadCloudConfig(reload = false) {
    let cfg = await rclient.getAsync(Constants.REDIS_KEY_EVENT_SUMMARY_CLOUD_CONFIG).then(r => r && JSON.parse(r)).catch(() => null);
    this.cloudConfig = cfg;
    if (_.isEmpty(cfg) || reload) {
      cfg = await bone.hashsetAsync(Constants.KEY_EVENT_SUMMARY_CONFIG).then(r => r && JSON.parse(r)).catch(() => null);
      if (!_.isEmpty(cfg) && _.isObject(cfg)) {
        await rclient.setAsync(Constants.REDIS_KEY_EVENT_SUMMARY_CLOUD_CONFIG, JSON.stringify(cfg));
        this.cloudConfig = cfg;
      }
    }
  }

  // drops unusable settings and normalizes "period", so a bad cloud push degrades to "this setting
  // is ignored" rather than to NaN-keyed redis entries or a "du" that lies about the bucket length
  _validateSettings(settings) {
    const valid = [];
    for (const setting of settings) {
      if (!_.isObject(setting) || !setting.key) {
        log.error('Ignoring event summary setting without a key', setting);
        continue;
      }
      // matchFilter() returns false for an empty node, a setting without a filter would silently
      // never match, which is far more confusing than dropping it here
      if (_.isEmpty(setting.filter)) {
        log.error(`Ignoring event summary setting ${setting.key} without a filter`);
        continue;
      }
      if (!_.isArray(setting.labelKeys) || _.isEmpty(setting.labelKeys)) {
        log.error(`Ignoring event summary setting ${setting.key} without labelKeys`);
        continue;
      }
      const period = Number(setting.period);
      // periods must tile a local day evenly, otherwise the last bucket of each day is short
      if (!tilesLocalDay(period)) {
        log.warn(`Invalid period(${setting.period}) for event summary setting ${setting.key}, falling back to ${DEFAULT_PERIOD}`);
        valid.push(Object.assign({}, setting, { period: DEFAULT_PERIOD }));
      } else {
        valid.push(Object.assign({}, setting, { period }));
      }
    }
    return valid;
  }

  // start of the period containing tsSec, pivoted on local midnight. See util/TimeSlot.js
  _periodStart(tsSec, period) {
    return localSlotStart(tsSec, period, SysManager.getTimezone());
  }

  // JSON-encode the label tuple so the Map/record key is both human-readable and collision-free (a
  // plain string join could conflate e.g. a="AA",b="BCC" with a="AAB",b="CC").
  // The isNil->null matters: JSON.stringify([undefined]) is "[null]", so without it every record with a
  // missing label would collapse into one group while the stored record silently dropped the field
  _getRecordJoinedKey(setting, labels) {
    return JSON.stringify(setting.labelKeys.map(k => _.isNil(labels[k]) ? null : labels[k]));
  }

  _getBucketKey(setting, bucketTs) {
    // "du" belongs in the key: with local midnight as the pivot, a period:86400 and a period:3600
    // bucket for the same setting key share an identical first-bucket ts, so a config change to
    // "period" would otherwise merge an hour bucket into a day bucket
    return `${Constants.REDIS_KEY_EVENT_SUMMARY_PREFIX}${setting.key}::${setting.period}::${bucketTs}`;
  }

  async _onEvent(event) {
    if (!event || event.event_type !== 'state') return; // only state events are summarized for now

    // event.ts is in MILLISECONDS (EventRequestApi defaults it to Date.now(), and event:log zset
    // scores are ms), unlike the seconds-based _ts that BlockStatsSensor buckets on
    const tsMs = Number(event.ts);
    if (!Number.isFinite(tsMs)) {
      log.warn(`Ignoring event with invalid ts(${event.ts})`);
      return;
    }
    // seconds only for choosing the bucket - ordering below keeps full ms precision, two events in
    // the same second would otherwise tie and let a late-arriving older one overwrite end_state
    const tsSec = Math.floor(tsMs / 1000);
    const labels = event.labels || {};

    for (const setting of this.eventSummaryConfs.eventSummarySettings) {
      // filter matches the raw event's top-level fields, labels are NOT visible to it
      if (!matchFilter(setting.filter, event)) continue;
      const bucketTs = this._periodStart(tsSec, setting.period);
      const redisKey = this._getBucketKey(setting, bucketTs);
      const joinedKey = this._getRecordJoinedKey(setting, labels);
      await this.lock.acquire(redisKey, async () => {
        await this._upsertRecord(setting, redisKey, bucketTs, joinedKey, labels, event, tsMs);
      }).catch(err => log.error(`Failed to update event summary at ${redisKey}`, err.message));
    }
  }

  // tsMs is the event timestamp in milliseconds - the first/last guards below need the full
  // precision, truncating to seconds makes same-second events tie
  async _upsertRecord(setting, redisKey, bucketTs, joinedKey, labels, event, tsMs) {
    let payload = await rclient.getAsync(redisKey).then(r => r && JSON.parse(r)).catch(err => {
      log.error(`Failed to parse event summary bucket ${redisKey}`, err.message);
      return null;
    });
    // NOTE: a timezone change can make _periodStart resolve to a bucket that was written under the
    // previous timezone, so a bucket spanning a change covers a slightly fuzzy window. The bucket is
    // deliberately NOT reset - every value in it still describes events that actually happened, and
    // the first/last guards below keep prev_state/end_state anchored to real timestamps. Discarding
    // it would lose real observations, which is the worse trade
    if (!payload || !_.isArray(payload.records))
      payload = { ts: bucketTs, du: setting.period, key: setting.key, records: [] };

    const stateValue = event.state_value;
    let record = payload.records.find(r => r._k === joinedKey);
    if (!record) {
      if (payload.records.length >= MAX_RECORDS_PER_KEY) {
        // records cap reached for this key/bucket - drop new distinct records rather than growing
        // unbounded; accepted accuracy tradeoff to bound the redis payload size
        return;
      }
      const prev = Number(event.prev_state_value);
      record = { _k: joinedKey };
      for (const k of setting.labelKeys) record[k] = _.isNil(labels[k]) ? null : labels[k];
      // prev_state_value is only set on a state TRANSITION, a no_error event's very first sighting
      // has none. Emit an explicit null rather than letting JSON.stringify drop the field
      record.prev_state = Number.isFinite(prev) ? prev : null;
      record.end_state = stateValue;
      record.seen_states = [stateValue];
      record.cnt = 1;
      record._firstTs = tsMs;
      record._lastTs = tsMs;
      payload.records.push(record);
    } else {
      // emission order is NOT ts order - ap_* events go through a bee-queue while others are
      // processed inline, and the redis message handler doesn't serialize - so guard on ts rather
      // than assuming arrival order. This also keeps the bucket correct across a sensor restart
      if (tsMs >= record._lastTs) {
        record.end_state = stateValue;
        record._lastTs = tsMs;
      }
      if (tsMs < record._firstTs) {
        const prev = Number(event.prev_state_value);
        record.prev_state = Number.isFinite(prev) ? prev : null;
        record._firstTs = tsMs;
      }
      if (!record.seen_states.includes(stateValue) && record.seen_states.length < MAX_SEEN_STATES)
        record.seen_states.push(stateValue);
      record.cnt++;
    }

    // expire on the bucket's own horizon rather than a flat EX from write time, otherwise a late
    // write in the bucket's day renews the TTL past the index prune and leaves an orphaned key
    const ttl = bucketTs + setting.period + RETENTION_SECS - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return;
    const multi = rclient.multi();
    multi.set(redisKey, JSON.stringify(payload), 'EX', ttl);
    multi.zadd(Constants.REDIS_KEY_EVENT_SUMMARY_INDEX, bucketTs, redisKey);
    // prune with a day of slack rather than exactly RETENTION_SECS: the reader (HostManager) uses a
    // 7-CALENDAR-day window, which spans more than 7*86400 seconds across a fall-back DST day, so an
    // exact cutoff drops index entries init still wants. Over-retaining is harmless - a stale entry
    // whose payload has expired is simply skipped when the reader mgets it
    multi.zremrangebyscore(Constants.REDIS_KEY_EVENT_SUMMARY_INDEX, '-inf',
      Math.floor(Date.now() / 1000) - RETENTION_SECS - 86400);
    await multi.execAsync();
  }
}

module.exports = EventSummarySensor;
