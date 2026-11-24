/*    Copyright 2016-2024 Firewalla Inc.
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
const TimeSeries = require('redis-timeseries')
const Constants = require('../net2/Constants.js');
const _ = require('lodash')

const log = require('../net2/logger.js')(__filename, 'info');
const rclient = require('../util/redis_manager.js').getMetricsRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');

let timezone;

const oneDay = 86400;

sclient.on("message", async (channel, message) => {
  if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
    log.info(`System timezone is reloaded, update timezone`, message);
    timezone = message;
  }
});
sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);

const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

// Get current timestamp in seconds
var getCurrentTime = function() {
  return Math.floor(Date.now() / 1000);
};

// Round timestamp to the 'precision' interval (in seconds)
var getRoundedTime = function (precision, time, skipTzCheck) {
  time = time || getCurrentTime();
  let ts = Math.floor(time / precision) * precision;
  // if it is keyTimestamp, return ts directly
  // only 1day and 1month granularity need check timezone
  if (skipTzCheck || precision < oneDay) return ts;
  let timeDate, tsDate;
  if (!timezone) {
    timeDate = moment(time * 1000).get('date');
    tsDate = moment(ts * 1000).get('date');
  } else {
    timeDate = moment(time * 1000).tz(timezone).get('date');
    tsDate = moment(ts * 1000).tz(timezone).get('date');
  }
  if (timeDate == tsDate) { // same day
    return ts;
  } else { // not same day
    if (ts > time) { // reduce one day of ts
      ts = ts - oneDay;
    } else {
      ts = ts + oneDay;
    }
    return ts;
  }
};

// override recordHit function
/**
 * Record a hit for the specified stats key
 * This method is chainable:
 * --> var ts = new TimeSeries(redis)
 *              .recordHit("messages")
 *              .recordHit("purchases", ts)
 *              .recordHit("purchases", ts, 3)
 *              ...
 *              .exec([callback]);
 *
 * `timestamp` should be in seconds, and defaults to current time.
 * `increment` should be an integer, and defaults to 1
 * `granularities` is an optional subset of this.granularities to record to, defaults to all
 */
TimeSeries.prototype.recordHit = function(key, timestamp, increment, callback=()=>{}, granularities) {
  var self = this;

  (granularities || Object.keys(this.granularities)).forEach(function(gran) {
    var properties = self.granularities[gran];
    if (!properties) throw new Error("Unsupported granularity: " + gran);
    var keyTimestamp = getRoundedTime(properties.precision || properties.ttl, timestamp,true), // high prority: precision
        tmpKey = [self.keyBase, key, gran, keyTimestamp].join(':'),
        hitTimestamp = getRoundedTime(properties.duration, timestamp);

    if (typeof self.redis.hincrbyAndExpireatBulk === "function") {
      const pending = self.redis.hincrbyAndExpireatBulk(tmpKey, hitTimestamp, Math.floor(increment || 1), keyTimestamp + 2 * properties.ttl, !self.noMulti)
      if (pending) {
        pending.then(() => callback()).catch(err => callback(err))
      } else {
        callback()
      }
    } else {
      if (self.noMulti) {
        self.redis.hincrby(tmpKey, hitTimestamp, Math.floor(increment || 1), (err) => {
          if(err) {
            callback(err)
            return
          }
          self.redis.expireat(tmpKey, keyTimestamp + 2 * properties.ttl, (err2) => {
            callback(err2)
          });
        });
      } else {
        self.pendingMulti.hincrby(tmpKey, hitTimestamp, Math.floor(increment || 1));
        self.pendingMulti.expireat(tmpKey, keyTimestamp + 2 * properties.ttl);
      }
    }
  });

  return this;
};

/**
 * Execute the current pending redis multi
 */
TimeSeries.prototype.exec = function(callback = ()=>{}) {
  if(this.noMulti) {
    callback()
    return
  }

  if (typeof this.redis.execBatch === "function") {
    this.redis.execBatch().then(() => callback())
    return
  }
  // Reset pendingMulti before proceeding to
  // avoid concurrent modifications
  var current = this.pendingMulti;
  this.pendingMulti = this.redis.batch();
  current.exec(callback);
  current = null
};


// Pure planning step of getHits: figures out which redis keys/fields are needed
// and how to turn their (later-fetched) values back into [ts, count] pairs.
// Factored out so multiple granularities can be queued onto one shared MULTI
// (see queueHits) instead of each opening its own multi/exec round trip.
function planHits(instance, key, gran, count) {
  const properties = instance.granularities[gran];
  if (typeof properties === "undefined") {
    throw new Error("Unsupported granularity: " + gran);
  }
  if (count > properties.ttl / properties.duration) {
    throw new Error("Count: " + count + " exceeds the maximum stored slots for granularity: " + gran);
  }

  const currentTime = getCurrentTime();
  const from = getRoundedTime(properties.duration, currentTime - count * properties.duration),
        to = getRoundedTime(properties.duration, currentTime);

  const hget = {}
  const orderedKeys = []
  for (var ts = from; ts <= to; ts += properties.duration) {
    var keyTimestamp = getRoundedTime(properties.precision || properties.ttl, ts, true), // high prority: precision
        tmpKey = [instance.keyBase, key, gran, keyTimestamp].join(':');

    if (!hget[tmpKey]) {
      hget[tmpKey] = [ts]
      orderedKeys.push(tmpKey)
    } else
      hget[tmpKey].push(ts)
  }

  return { from, to, duration: properties.duration, hget, orderedKeys };
}

function parseHits(plan, flatResults, count) {
  const data = []
  for (var ts = plan.from, i = 0; ts <= plan.to; ts += plan.duration, i += 1) {
    data.push([ts, flatResults[i] ? parseInt(flatResults[i], 10) : 0]);
  }
  return data.slice(Math.max(data.length - count, 0));
}

// override getHits function
TimeSeries.prototype.getHits = function(key, gran, count, callback) {
  let plan;
  try {
    plan = planHits(this, key, gran, count);
  } catch (err) {
    return callback(err);
  }

  const multi = this.redis.multi()
  for (const k of plan.orderedKeys) {
    multi.hmget(k, plan.hget[k])
  }

  multi.exec(function(err, results) {
    if (err) {
      return callback(err);
    }
    return callback(null, parseHits(plan, _.flatten(results), count));
  });
};

// Queues getHits' hmget commands onto a caller-supplied multi so several
// granularities (plus other commands) share one MULTI/EXEC round trip.
// Returns the plan plus how many result slots belong to this call, for slicing
// results back out after exec().
TimeSeries.prototype.queueHits = function(multi, key, gran, count) {
  const plan = planHits(this, key, gran, count);
  for (const k of plan.orderedKeys) {
    multi.hmget(k, plan.hget[k])
  }
  return { plan, resultSlots: plan.orderedKeys.length };
};

// Turns the slice of MULTI/EXEC results belonging to a queueHits() call back
// into the same [ts, count] pairs getHits would have returned.
TimeSeries.prototype.parseQueuedHits = function(queued, resultSlice, count) {
  return parseHits(queued.plan, _.flatten(resultSlice), count);
};

// Queues the hourly hits of the last 24 hours and the daily hits of the last 7 days of key
TimeSeries.prototype.queueRecentSummary = function(multi, key) {
  const q24h = this.queueHits(multi, key, Constants.TS_GRAN_1HOUR, 24);
  const q7d = this.queueHits(multi, key, Constants.TS_GRAN_1DAY, 7);
  return { q24h, q7d, resultSlots: q24h.resultSlots + q7d.resultSlots };
};

// { total24h, total7d, daily7d } from the results of a queueRecentSummary() call, no results
// (a failed read) count as no hits
TimeSeries.prototype.parseRecentSummary = function(queued, resultSlice, label) {
  let buckets24h = [], buckets7d = [];
  if (resultSlice) {
    buckets24h = this.parseQueuedHits(queued.q24h, resultSlice.slice(0, queued.q24h.resultSlots), 24);
    buckets7d = this.parseQueuedHits(queued.q7d, resultSlice.slice(queued.q24h.resultSlots, queued.resultSlots), 7);
  }
  const total24h = buckets24h.reduce((sum, bucket) => sum + (bucket[1] || 0), 0);
  let total7d = buckets7d.reduce((sum, bucket) => sum + (bucket[1] || 0), 0);
  const daily7d = buckets7d;
  if (total24h > total7d) {
    const delta = total24h - total7d;
    log.warn(`${label} total24h (${total24h}) is ahead of total7d (${total7d})`);
    total7d = total24h;
    if (daily7d.length)
      daily7d[daily7d.length - 1][1] += delta;
  }
  return { total24h, total7d, daily7d };
};

const timeSeries = new TimeSeries(rclient, "timedTraffic")
timeSeries.granularities = {
  [Constants.TS_GRAN_1MINUTE]  : { ttl: timeSeries.minutes(65)  , duration: timeSeries.minutes(1) },
  [Constants.TS_GRAN_15MINUTES]: { ttl: timeSeries.hours(50)  , duration: timeSeries.minutes(15) },
  [Constants.TS_GRAN_1HOUR]    : { ttl: timeSeries.days(7)   , duration: timeSeries.hours(1) },
  [Constants.TS_GRAN_1DAY]     : { ttl: timeSeries.weeks(53) , duration: timeSeries.days(1), precision:timeSeries.weeks(52) },
  [Constants.TS_GRAN_1MONTH]   : { ttl: timeSeries.months(24) , duration: timeSeries.months(1) }
}

const boneAPITimeSeries = new TimeSeries(rclient, "boneAPIUsage")
boneAPITimeSeries.granularities = {
  [Constants.TS_GRAN_1MINUTE]  : { ttl: boneAPITimeSeries.minutes(60)  , duration: boneAPITimeSeries.minutes(1) },
  [Constants.TS_GRAN_1HOUR]    : { ttl: boneAPITimeSeries.days(7)   , duration: boneAPITimeSeries.hours(1) },
  [Constants.TS_GRAN_1DAY]     : { ttl: boneAPITimeSeries.days(30) , duration: boneAPITimeSeries.days(1) },
}
boneAPITimeSeries.noMulti = true

// set flag
const timeSeriesWithTzBeginingTs = "time_series_with_tz_ts";
(async () => {
  const ts = await rclient.hgetAsync("sys:config", timeSeriesWithTzBeginingTs)
  if (!ts) {
    await rclient.hsetAsync("sys:config", timeSeriesWithTzBeginingTs, new Date() / 1000);
  }
})()

module.exports = {
  // what HostManager.getStats serves; 15minutes is only read for download/upload
  STATS_GRANULARITIES: [Constants.TS_GRAN_1MINUTE, Constants.TS_GRAN_1HOUR, Constants.TS_GRAN_1DAY, Constants.TS_GRAN_1MONTH],
  getTimeSeries: function () { return timeSeries },
  getBoneAPITimeSeries: function () { return boneAPITimeSeries }
}
