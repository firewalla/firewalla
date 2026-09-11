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

const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

// Start of the slot of length `period` containing `tsSec`, using LOCAL midnight in `tz` as the
// pivot. Returns a real epoch second, NOT a timezone-shifted value.
//
// startOf('day') rather than arithmetic on a fixed utc offset keeps the boundary on actual midnight
// across DST transitions. On a DST-start day where local midnight doesn't exist it returns the first
// valid instant of the day, so dayStart <= tsSec always holds.
//
// A local day is 23h, 24h or 25h long, but it always holds the same NUMBER of slots
// (ceil(86400/period), the last one short when period doesn't divide a day).
// On a 25h day the index is clamped so the extra hour is absorbed by the day's last slot rather than
// spilling into an extra one - without the clamp, 23:00-24:00 on a fall-back day would open a second
// bucket for the same local day. So a slot can be longer or shorter than `period`: never compute a
// slot's end as start + period.
//
// `period` should divide 86400 evenly, otherwise the last slot of each local day is short.
// An unknown or empty tz falls back to UTC (never to the process's own timezone).
function localSlotStart(tsSec, period, tz) {
  // fall back to UTC explicitly, NOT to bare moment() - a bare moment resolves in the process's own
  // timezone, which would make slot boundaries depend on the box's system TZ rather than on config
  const zone = tz && moment.tz.zone(tz) ? tz : 'UTC';
  const dayStart = moment.unix(tsSec).tz(zone).startOf('day').unix();
  // ceil, not floor: a period that doesn't divide 86400 leaves a short trailing slot, and flooring
  // would clamp it away and merge it into the previous one
  const lastIdx = Math.max(0, Math.ceil(86400 / period) - 1);
  const idx = Math.min(Math.floor((tsSec - dayStart) / period), lastIdx);
  return dayStart + idx * period;
}

// whether `period` tiles a local day evenly
function tilesLocalDay(period) {
  return Number.isInteger(period) && period > 0 && period <= 86400 && 86400 % period === 0;
}

module.exports = { localSlotStart, tilesLocalDay };
