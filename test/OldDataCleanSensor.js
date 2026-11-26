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

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();

// a value that can be called, constructed and dereferenced to any depth,
// stands in for the singletons and clients the sensor builds at load time
function anything() {
  const proxy = new Proxy(function () {}, {
    get: (target, prop) => (prop === 'then' || typeof prop === 'symbol') ? undefined : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

describe('OldDataCleanSensor traffic stats of removed tags', () => {
  const liveTags = ['7', '21'];
  let sensor, lookups;

  beforeEach(() => {
    const src = fs.readFileSync(path.join(__dirname, '../sensor/OldDataCleanSensor.js'), 'utf8');
    const stubs = {};
    for (const [, name] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g))
      stubs[name] = anything();
    stubs['./Sensor.js'] = { Sensor: class { constructor(config) { this.config = config || {}; } } };
    stubs['../net2/Constants.js'] = require('../net2/Constants.js');
    stubs['../net2/CommonKeys.js'] = require('../net2/CommonKeys.js');
    lookups = [];
    stubs['../net2/TagManager.js'] = {
      tagUidExists: async (uid) => { lookups.push(uid); return liveTags.includes(uid); }
    };
    const OldDataCleanSensor = proxyquire('../sensor/OldDataCleanSensor.js', stubs);
    sensor = new OldDataCleanSensor({});
    sensor.filterFunctions = [];
    sensor.registerFilterFunctions();
    sensor.tagExists = new Map();
  });

  // runs a key through every registered filter the way regularClean does
  async function clean(keys) {
    const batch = [];
    for (const key of keys) {
      for (const { type, filterFunc, customCleanerFunc } of sensor.filterFunctions) {
        if (type === 'tagTimeSeries' && filterFunc(key))
          await customCleanerFunc(type, key, batch);
      }
    }
    return batch;
  }

  it('unlinks every stat and granularity of a tag that no longer exists', async () => {
    const keys = [
      'timedTraffic:conn:tag:165351:1day:1760572800',
      'timedTraffic:upload:tag:165351:1month:1741824000',
      'timedTraffic:download:lo:tag:165351:1hour:1795132800',
      'timedTraffic:conn:lo:intra:tag:165351:1day:1760572800',
      'timedTraffic:ipB:lo:in:tag:165351:1day:1760572800',
      'timedTraffic:dnsB:tag:165351:15minutes:1760572800',
      'timedTraffic:upload:lo:tag:165351:1minute:1760572800',
    ];
    expect(await clean(keys)).to.eql(keys.map(k => ['unlink', k]));
  });

  it('keeps the stats of a tag that exists', async () => {
    const batch = await clean([
      'timedTraffic:conn:tag:7:1day:1760572800',
      'timedTraffic:download:lo:tag:21:1month:1741824000',
      'timedTraffic:conn:tag:99999:1day:1760572800',
    ]);
    expect(batch).to.eql([['unlink', 'timedTraffic:conn:tag:99999:1day:1760572800']]);
  });

  it('leaves time series that do not belong to a tag alone', async () => {
    const keys = [
      'timedTraffic:download:1day:1760572800',
      'timedTraffic:download:00:00:5E:00:53:01:1day:1760572800',
      'timedTraffic:upload:intf:11111111-2222-3333-4444-555555555555:1month:1741824000',
      'timedTraffic:download:wan:11111111-2222-3333-4444-555555555555:1day:1760572800',
      'timedTraffic:feature:adblock:block:1day:1760572800',
      'timedTraffic:blockStatsAggrCounter:block::country::RU:1day:1760572800',
      'timedTraffic:blockStatsAggrCounter:block::tag:165351:1day:1760572800',
      'timedTraffic:blockStatsAggrCounter:tag:165351:1hour:1760572800',
      'timedTraffic:blockStatsAggrCounter:lo:tag:165351:1hour:1760572800',
      'timedTraffic:blockStatsAggrCounter:block::dest::tag:165351:1day:1760572800',
      'boneAPIUsage:tag:165351:1day:1760572800',
      'policy:tag:165351',
    ];
    expect(await clean(keys)).to.eql([]);
    expect(lookups).to.eql([]);
  });

  it('looks a tag up once however many keys it has', async () => {
    const keys = [];
    for (let i = 0; i < 50; i++)
      keys.push(`timedTraffic:conn:tag:165351:1day:${1760572800 + i}`, `timedTraffic:conn:tag:7:1day:${1760572800 + i}`);
    expect(await clean(keys)).to.have.lengthOf(50);
    expect(lookups.sort()).to.eql(['165351', '7']);
  });
});
