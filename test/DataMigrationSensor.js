/*    Copyright 2026 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient();
const DataMigrationSensor = require('../sensor/DataMigrationSensor.js');
const FlowAggrTool = require('../net2/FlowAggrTool.js');
const flowAggrTool = new FlowAggrTool();
const IntelTool = require('../net2/IntelTool.js');
const intelTool = new IntelTool();

describe('DataMigrationSensor.backfillSumFlowKey', () => {
  const key = 'unittest:sumflow:backfill'
  const mac = '00:00:5E:00:53:05'
  const intels = {
    '203.0.113.60': {category: 'intel', cc: '["phishing"]'},
    '203.0.113.61': {category: 'intel', cc: '["malware"]'},
    '203.0.113.62': {category: 'porn'},
    '203.0.113.63': {category: 'intel'},
  }
  const member = entry => flowAggrTool.getFlowStr(mac, Object.assign({fd: 'in'}, entry))
  let getIntel, sensor

  before(() => {
    sensor = new DataMigrationSensor({})
    getIntel = intelTool.getIntel
    intelTool.getIntel = async ip => intels[ip]
  })

  after(async () => {
    intelTool.getIntel = getIntel
    await rclient.unlinkAsync(key)
  })

  it('should add c and cc to members that miss them and keep the score', async () => {
    const intelCode = await intelTool.categoryToNumber('intel')
    const pornCode = await intelTool.categoryToNumber('porn')
    await rclient.zaddAsync(key,
      10, member({destIP: '203.0.113.60', c: intelCode}), // written before cc
      20, member({destIP: '203.0.113.61'}),               // written before c
      30, member({destIP: '203.0.113.62', c: pornCode}),  // complete
      40, member({destIP: '203.0.113.63', c: intelCode}), // intel with no cc to add
    )

    await sensor.backfillSumFlowKey(key)

    const result = await rclient.zrangeAsync(key, 0, -1, 'withscores')
    expect(result.length).to.equal(8)
    const byDest = {}
    for (let i = 0; i < result.length; i += 2) {
      const entry = JSON.parse(result[i])
      byDest[entry.destIP] = {c: entry.c, cc: entry.cc, score: Number(result[i + 1])}
    }
    expect(byDest).to.deep.equal({
      '203.0.113.60': {c: intelCode, cc: 'phishing', score: 10},
      '203.0.113.61': {c: intelCode, cc: 'malware', score: 20},
      '203.0.113.62': {c: pornCode, cc: undefined, score: 30},
      '203.0.113.63': {c: intelCode, cc: undefined, score: 40},
    })
  })
});
