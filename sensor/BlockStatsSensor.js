/*    Copyright 2016-2025 Firewalla Inc.
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
const { localSlotStart, tilesLocalDay } = require('../util/TimeSlot.js');

const DEFAULT_SLOT_SECS = 10800; // 3 hours, used when "slotSecs" isn't configured
const BUCKET_TTL = 86400 * 7; // 7 days
const FLUSH_INTERVAL = 60 * 1000; // 1 minute
const MAX_RECORDS_PER_BUCKET = 400; // cap on distinct records per key per bucket, to bound redis payload size

class BlockStatsSensor extends Sensor {
  constructor(config) {
    super(config);
    this.buckets = {};      // { [bucketTs]: { [settingKey]: { since, records: Map<joinedKey, {...fields, cnt}> } } }
    this.dirty = new Set(); // `${bucketTs}:${settingKey}` touched since last flush
    this.blockStatsConfs = { blockStatsSettings: [], slotSecs: DEFAULT_SLOT_SECS };
    this.slotSecs = DEFAULT_SLOT_SECS;
    sem.on(Message.MSG_BLOCK_FLOW_STATS_UPDATE, event => this._onBlockFlow(event));
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

    await this._reloadRecentBucketsFromRedis().catch(err => {
      log.error('Failed to reload recent block stats buckets from redis', err.message);
    });

    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      this._flushAndPurge().catch(err => log.error('Failed to flush block stats', err));
    }, FLUSH_INTERVAL);
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
          log.error(`Failed to load block stats cloud config`, err.message);
        });
      }, delayMins * 60 * 1000);
    }, () => { }, true, tz);
  }

  async loadConfig(forceReload = false) {
    await this.loadCloudConfig(forceReload).catch((err) => {
      log.error(`Failed to load block stats config from cloud`, err.message);
    });
    // blockStatsSettings is an array of objects, _.merge on arrays merges by index rather than
    // concatenating/keying by "key", so the cloud config (when present) fully replaces the local
    // default array rather than being deep-merged with it
    const cloudSettings = this.cloudConfig && this.cloudConfig.blockStatsSettings;
    const localSettings = this.config && this.config.blockStatsSettings;
    const cloudSlotSecs = this.cloudConfig && this.cloudConfig.slotSecs;
    const localSlotSecs = this.config && this.config.slotSecs;
    this.blockStatsConfs = {
      blockStatsSettings: (!_.isEmpty(cloudSettings) ? cloudSettings : localSettings) || [],
      slotSecs: cloudSlotSecs || localSlotSecs || DEFAULT_SLOT_SECS
    };
    // note: changing slotSecs takes effect only for buckets created after the change - any
    // in-memory buckets keyed under the previous slotSecs keep accumulating under their old
    // boundaries until they're flushed/purged, an accepted transitional inaccuracy. The same
    // applies to a timezone change, since slot boundaries are pivoted on local midnight
    this.slotSecs = this.blockStatsConfs.slotSecs;
    // slots are pivoted on local midnight, so a slotSecs that doesn't divide a day leaves a short
    // trailing slot every day. Warn rather than override - unlike EventSummarySensor's "period",
    // slotSecs is already deployed and silently changing a configured value would be worse
    if (!tilesLocalDay(this.slotSecs))
      log.warn(`slotSecs(${this.slotSecs}) does not divide 86400 evenly, the last slot of each local day will be short`);
  }

  // start of the slot containing tsSec, pivoted on local midnight. See util/TimeSlot.js
  _slotStart(tsSec) {
    return localSlotStart(tsSec, this.slotSecs, SysManager.getTimezone());
  }

  async loadCloudConfig(reload = false) {
    let cfg = await rclient.getAsync(Constants.REDIS_KEY_BLOCK_STATS_CLOUD_CONFIG).then(r => r && JSON.parse(r)).catch(() => null);
    this.cloudConfig = cfg;
    if (_.isEmpty(cfg) || reload) {
      cfg = await bone.hashsetAsync(Constants.KEY_BLOCK_STATS_CONFIG).then(r => r && JSON.parse(r)).catch(() => null);
      if (!_.isEmpty(cfg) && _.isObject(cfg)) {
        await rclient.setAsync(Constants.REDIS_KEY_BLOCK_STATS_CLOUD_CONFIG, JSON.stringify(cfg));
        this.cloudConfig = cfg;
      }
    }
  }

  // JSON-encode the field-value tuple so the Map key is both human-readable and
  // collision-free (a plain string join could conflate e.g. device="AA",dest="BCC"
  // with device="AAB",dest="CC")
  _getRecordJoinedKey(values) {
    return JSON.stringify(values);
  }

  _onBlockFlow(event) {
    const { _ts, ct = 1 } = event;
    const bucketTs = this._slotStart(_ts);
    for (const setting of this.blockStatsConfs.blockStatsSettings) {
      if (!matchFilter(setting.filter, event)) continue;
      const { key: settingKey, recordKeys } = setting;
      const fields = {};
      for (const f of recordKeys) fields[f] = event[f];
      const joinedKey = this._getRecordJoinedKey(recordKeys.map(f => event[f]));

      this.buckets[bucketTs] = this.buckets[bucketTs] || {};
      const bucket = this.buckets[bucketTs][settingKey] = this.buckets[bucketTs][settingKey] || { since: _ts, records: new Map() };

      const rec = bucket.records.get(joinedKey);
      if (rec) {
        rec.cnt += ct;
      } else if (bucket.records.size < MAX_RECORDS_PER_BUCKET) {
        bucket.records.set(joinedKey, { ...fields, cnt: ct });
      } else {
        // records cap reached for this key/bucket - drop new distinct records rather than growing
        // unbounded; accepted accuracy tradeoff to bound the redis payload size
        continue;
      }
      bucket.since = Math.min(bucket.since, _ts);
      this.dirty.add(`${bucketTs}:${settingKey}`);
    }
  }

  async _flushAndPurge() {
    const nowBucket = this._slotStart(Math.floor(Date.now() / 1000));
    const staleCutoff = nowBucket - this.slotSecs * 2; // keep current + previous bucket only

    const multi = rclient.multi();
    for (const bucketTs of Object.keys(this.buckets)) {
      const settingsAtBucket = this.buckets[bucketTs];
      const dirtyKeys = Object.keys(settingsAtBucket).filter(k => this.dirty.has(`${bucketTs}:${k}`));
      if (dirtyKeys.length === 0) continue;
      // clear before serializing, not after the await below, so a concurrent increment that
      // re-marks dirty during the redis write isn't lost
      for (const k of dirtyKeys) this.dirty.delete(`${bucketTs}:${k}`);
      const payload = {
        ts: Number(bucketTs),
        du: this.slotSecs, // slot length in seconds, self-describing in case slotSecs changes later
        blockStats: Object.keys(settingsAtBucket).map(key => ({
          key,
          since: settingsAtBucket[key].since,
          records: Array.from(settingsAtBucket[key].records.values())
        }))
      };
      multi.set(`${Constants.REDIS_KEY_BLOCK_STATS_PREFIX}${bucketTs}`, JSON.stringify(payload), 'EX', BUCKET_TTL);
      // index this bucket's timestamp so readers can enumerate actually-existing buckets
      // without having to guess boundaries from the (possibly since-changed) slotSecs config
      multi.zadd(Constants.REDIS_KEY_BLOCK_STATS_INDEX, Number(bucketTs), bucketTs);
    }
    // drop index entries whose underlying blockStats::<ts> key has already expired (TTL is
    // BUCKET_TTL from wall-clock write time, so anything older than that is definitely gone)
    const indexCutoff = Math.floor(Date.now() / 1000) - BUCKET_TTL;
    multi.zremrangebyscore(Constants.REDIS_KEY_BLOCK_STATS_INDEX, '-inf', indexCutoff);
    await multi.execAsync();

    for (const bucketTs of Object.keys(this.buckets)) {
      if (Number(bucketTs) < staleCutoff) delete this.buckets[bucketTs];
    }
  }

  async _reloadRecentBucketsFromRedis() {
    const nowBucket = this._slotStart(Math.floor(Date.now() / 1000));
    // the slot holding the second just before the current one - derived rather than subtracting
    // slotSecs, so it stays right across a local-day boundary and across a DST transition
    const candidates = [nowBucket, this._slotStart(nowBucket - 1)];
    const keys = candidates.map(ts => `${Constants.REDIS_KEY_BLOCK_STATS_PREFIX}${ts}`);
    const values = await rclient.mgetAsync(keys);
    candidates.forEach((ts, i) => {
      if (!values[i]) return;
      try {
        const payload = JSON.parse(values[i]);
        this.buckets[ts] = {};
        for (const entry of (payload.blockStats || [])) {
          const recordsMap = new Map();
          for (const r of entry.records) {
            const { cnt, ...fields } = r;
            const joinedKey = this._getRecordJoinedKey(Object.values(fields));
            recordsMap.set(joinedKey, r);
          }
          this.buckets[ts][entry.key] = { since: entry.since, records: recordsMap };
        }
      } catch (err) {
        log.error(`Failed to parse block stats bucket ${ts}`, err.message);
      }
    });
  }
}

module.exports = BlockStatsSensor;
