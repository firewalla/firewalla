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
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');
const CloudConfigLoader = require('./CloudConfigLoader.js');
const SysManager = require('../net2/SysManager.js');
const { matchFilter } = require('./BlockStatsFilter.js');
const { localSlotStart, tilesLocalDay } = require('../util/TimeSlot.js');

const DEFAULT_SLOT_SECS = 10800; // 3 hours, used when "slotSecs" isn't configured
const BUCKET_TTL = 86400 * 7; // 7 days
const FLUSH_INTERVAL = 60 * 1000; // 1 minute
// caps per key per bucket across all identities, to bound the redis payload size
const MAX_DESTS_PER_BUCKET = 400;
const MAX_DEVICES_PER_BUCKET = 400;
// identityKey entries: 'device' (the mac or VPN GUID itself) or a tag flowKey, e.g. userTags
const TAG_PREFIX_BY_FLOW_KEY = _.fromPairs(Object.values(Constants.TAG_TYPE_MAP).map(t => [t.flowKey, t.ruleTagPrefix]));
const IDENTITY_KEYS = ['device', ...Object.keys(TAG_PREFIX_BY_FLOW_KEY)];

class BlockStatsSensor extends Sensor {
  constructor(config) {
    super(config);
    // { [bucketTs]: { [settingKey]: { since, destTotal, deviceTotal,
    //   identities: Map<identity, { identity, cnt, dests: Map<joinedKey, {...destFields, cnt}>, devices: Set<mac> }> } } }
    this.buckets = {};
    this.dirty = new Set(); // `${bucketTs}:${settingKey}` touched since last flush
    this.blockStatsConfs = { blockStatsSettings: [], slotSecs: DEFAULT_SLOT_SECS };
    this.slotSecs = DEFAULT_SLOT_SECS;
    this.cloudConfigLoader = new CloudConfigLoader({
      cacheKey: Constants.REDIS_KEY_BLOCK_STATS_AGGR_CLOUD_CONFIG,
      hashsetName: Constants.KEY_BLOCK_STATS_AGGR_CONFIG,
      label: 'block stats',
      apply: cloudConfig => this.applyConfig(cloudConfig)
    });
    sem.on(Message.MSG_BLOCK_FLOW_STATS_UPDATE, event => this._onBlockFlow(event));
  }

  async run() {
    await this.cloudConfigLoader.start();

    await this._reloadRecentBucketsFromRedis().catch(err => {
      log.error('Failed to reload recent block stats buckets from redis', err.message);
    });

    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      this._flushAndPurge().catch(err => log.error('Failed to flush block stats', err));
    }, FLUSH_INTERVAL);
  }

  applyConfig(cloudConfig) {
    // blockStatsSettings is an array of objects, _.merge on arrays merges by index rather than
    // concatenating/keying by "key", so the cloud config (when present) fully replaces the local
    // default array rather than being deep-merged with it
    const cloudSettings = cloudConfig && cloudConfig.blockStatsSettings;
    const localSettings = this.config && this.config.blockStatsSettings;
    const cloudSlotSecs = cloudConfig && cloudConfig.slotSecs;
    const localSlotSecs = this.config && this.config.slotSecs;
    this.blockStatsConfs = {
      blockStatsSettings: this._validateSettings((!_.isEmpty(cloudSettings) ? cloudSettings : localSettings) || []),
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

  // drops unusable settings, so a bad cloud push disables that setting rather than throwing on every event
  _validateSettings(settings) {
    if (!_.isArray(settings)) {
      log.error('Ignoring block stats settings that are not an array', settings);
      return [];
    }
    return settings.filter(setting => {
      if (!_.isObject(setting) || !setting.key || _.isEmpty(setting.filter)) {
        log.error('Ignoring block stats setting without a key or filter', setting);
        return false;
      }
      const { identityKey, destKeys } = setting;
      if (!_.isArray(identityKey) || _.isEmpty(identityKey) || !identityKey.every(k => IDENTITY_KEYS.includes(k))) {
        log.error(`Ignoring block stats setting ${setting.key} with invalid identityKey`, identityKey);
        return false;
      }
      if (!_.isArray(destKeys) || _.isEmpty(destKeys) || !destKeys.every(k => _.isString(k) && k.length > 0)) {
        log.error(`Ignoring block stats setting ${setting.key} with invalid destKeys`, destKeys);
        return false;
      }
      return true;
    });
  }

  // start of the slot containing tsSec, pivoted on local midnight. See util/TimeSlot.js
  _slotStart(tsSec) {
    return localSlotStart(tsSec, this.slotSecs, SysManager.getTimezone());
  }

  // the first identityKey entry with a value: a tag as "<ruleTagPrefix><uid>" (the device's own
  // tags come before its network's, so a network group never wins), or the device itself
  _getIdentity(identityKey, event) {
    for (const k of identityKey) {
      if (k === 'device') return event.device;
      const uids = event[k];
      if (!_.isEmpty(uids)) return `${TAG_PREFIX_BY_FLOW_KEY[k]}${uids[0]}`;
    }
    return null;
  }

  // JSON-encode the values so the Map key is collision-free (a plain string join could conflate
  // dest="AB",bTarget="C" with dest="A",bTarget="BC")
  _getDestJoinedKey(values) {
    return JSON.stringify(values);
  }

  _onBlockFlow(event) {
    const { _ts, ct = 1, device } = event;
    const bucketTs = this._slotStart(_ts);
    for (const setting of this.blockStatsConfs.blockStatsSettings) {
      if (!matchFilter(setting.filter, event)) continue;
      const identity = this._getIdentity(setting.identityKey, event);
      if (!identity) continue;
      const settingKey = setting.key;

      this.buckets[bucketTs] = this.buckets[bucketTs] || {};
      const bucket = this.buckets[bucketTs][settingKey] = this.buckets[bucketTs][settingKey] ||
        { since: _ts, destTotal: 0, deviceTotal: 0, identities: new Map() };

      let idRec = bucket.identities.get(identity);
      if (!idRec) {
        idRec = { identity, cnt: 0, dests: new Map(), devices: new Set() };
        bucket.identities.set(identity, idRec);
      }
      // the identity is counted even when a cap below drops its new dest or device
      idRec.cnt += ct;
      if (!idRec.devices.has(device) && bucket.deviceTotal < MAX_DEVICES_PER_BUCKET) {
        idRec.devices.add(device);
        bucket.deviceTotal++;
      }

      // null rather than undefined, so the key stays the same after a JSON round trip on reload
      const destValues = setting.destKeys.map(k => _.isNil(event[k]) ? null : event[k]);
      const joinedKey = this._getDestJoinedKey(destValues);
      const dest = idRec.dests.get(joinedKey);
      if (dest) {
        dest.cnt += ct;
      } else if (bucket.destTotal < MAX_DESTS_PER_BUCKET) {
        idRec.dests.set(joinedKey, { ..._.zipObject(setting.destKeys, destValues), cnt: ct });
        bucket.destTotal++;
      }
      bucket.since = Math.min(bucket.since, _ts);
      this.dirty.add(`${bucketTs}:${settingKey}`);
    }
  }

  _serializeBucket(bucket) {
    return Array.from(bucket.identities.values()).map(r => ({
      identity: r.identity,
      cnt: r.cnt,
      dests: Array.from(r.dests.values()),
      devices: Array.from(r.devices).map(mac => ({ mac })),
      deviceCnt: r.devices.size,
      destCnt: r.dests.size
    }));
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
          records: this._serializeBucket(settingsAtBucket[key])
        }))
      };
      multi.set(`${Constants.REDIS_KEY_BLOCK_STATS_AGGR_PREFIX}${bucketTs}`, JSON.stringify(payload), 'EX', BUCKET_TTL);
      // index this bucket's timestamp so readers can enumerate actually-existing buckets
      // without having to guess boundaries from the (possibly since-changed) slotSecs config
      multi.zadd(Constants.REDIS_KEY_BLOCK_STATS_AGGR_INDEX, Number(bucketTs), bucketTs);
    }
    // drop index entries whose underlying bucket key has already expired (TTL is BUCKET_TTL from
    // wall-clock write time, so anything older than that is definitely gone). The legacy index
    // is no longer written, this drains it
    const indexCutoff = Math.floor(Date.now() / 1000) - BUCKET_TTL;
    multi.zremrangebyscore(Constants.REDIS_KEY_BLOCK_STATS_AGGR_INDEX, '-inf', indexCutoff);
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
    const keys = candidates.map(ts => `${Constants.REDIS_KEY_BLOCK_STATS_AGGR_PREFIX}${ts}`);
    const values = await rclient.mgetAsync(keys);
    candidates.forEach((ts, i) => {
      if (!values[i]) return;
      try {
        const payload = JSON.parse(values[i]);
        this.buckets[ts] = {};
        for (const entry of (payload.blockStats || [])) {
          const bucket = { since: entry.since, destTotal: 0, deviceTotal: 0, identities: new Map() };
          for (const r of entry.records) {
            const dests = new Map();
            for (const d of r.dests) {
              const { cnt, ...fields } = d;
              dests.set(this._getDestJoinedKey(Object.values(fields)), d);
            }
            const devices = new Set(r.devices.map(d => d.mac));
            bucket.identities.set(r.identity, { identity: r.identity, cnt: r.cnt, dests, devices });
            bucket.destTotal += dests.size;
            bucket.deviceTotal += devices.size;
          }
          this.buckets[ts][entry.key] = bucket;
        }
      } catch (err) {
        log.error(`Failed to parse block stats bucket ${ts}`, err.message);
      }
    });
  }
}

module.exports = BlockStatsSensor;
