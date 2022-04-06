/*    Copyright 2016-2021 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getMetricsRedisClient()

const timeSeries = new TimeSeries(rclient, "timedTraffic")
timeSeries.granularities = {
  '1minute'  : { ttl: timeSeries.minutes(65)  , duration: timeSeries.minutes(1) },
  '15minutes': { ttl: timeSeries.hours(50)  , duration: timeSeries.minutes(15) },
  '1hour'    : { ttl: timeSeries.days(7)   , duration: timeSeries.hours(1) },
  '1day'     : { ttl: timeSeries.days(366) , duration: timeSeries.days(1) },
  '1month'   : { ttl: timeSeries.months(24) , duration: timeSeries.months(1) }
}

const boneAPITimeSeries = new TimeSeries(rclient, "boneAPIUsage")
boneAPITimeSeries.granularities = {
  '1minute'  : { ttl: boneAPITimeSeries.minutes(60)  , duration: boneAPITimeSeries.minutes(1) },
  '1hour'    : { ttl: boneAPITimeSeries.days(7)   , duration: boneAPITimeSeries.hours(1) },
  '1day'     : { ttl: boneAPITimeSeries.days(30) , duration: boneAPITimeSeries.days(1) },
}

// set flag
const timeSeriesWithTzBeginingTs = "time_series_with_tz_ts";
(async () => {
  const ts = await rclient.hgetAsync("sys:config", timeSeriesWithTzBeginingTs)
  if (!ts) {
    await rclient.hsetAsync("sys:config", timeSeriesWithTzBeginingTs, new Date() / 1000);
  }
})()

module.exports = {
  getTimeSeries: function () { return timeSeries },
  getBoneAPITimeSeries: function () { return boneAPITimeSeries }
}
