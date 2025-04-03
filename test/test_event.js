/*    Copyright 2025 Firewalla LLC
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
const eventapi = require('../event/EventApi.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

describe('Test event api', async () => {
  it('Should get event by score', async () => {
    const ts = Date.now();
    eventapi.addEvent({"event_type":"action", "action_type":"test"}, ts);

    let result = await eventapi.getEventByTs(ts);
    expect(result.action_type).to.be.equal("test");

    await rclient.zremrangebyscoreAsync("event:log", ts, ts);
  });

  it('Should get events', async() => {
    const ts = Date.now();
    eventapi.addEvent({"event_type":"action", "action_type":"test"}, ts);

    let result = await eventapi.getLatestEventsByType("test", 60000, 3);

    expect(result.length).to.equal(1);
    expect(result[0].ts).to.equal(ts);
    await rclient.zremrangebyscoreAsync("event:log", ts, ts);
  });
});

