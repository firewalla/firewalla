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
const eventhandler = require('../event/EventRequestHandler.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


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

describe('Test event handler state event', function() {
  this.timeout(10000);

  it("should handle state event", async () => {
    const now = Date.now();
    const state1 = {"event_type":"state","ts":now-3000,"state_type":"ap_test_type","state_value":0,"state_key":"test_key","labels":{"ok_value":0}};
    await eventhandler.queueStateEvent(JSON.stringify(state1));

    const state2 = {"event_type":"state","ts":now-2000,"state_type":"ap_test_type","state_value":1,"state_key":"test_key","labels":{"ok_value":0}};
    await eventhandler.queueStateEvent(JSON.stringify(state2));

    const state3 = {"event_type":"state","ts":now-1000,"state_type":"ap_test_type","state_value":0,"state_key":"test_key","labels":{"ok_value":0}};
    await eventhandler.queueStateEvent(JSON.stringify(state3));

    const state4 = {"event_type":"state","ts":now,"state_type":"ap_test_type","state_value":1,"state_key":"test_key","labels":{"ok_value":0}};
    await eventhandler.queueStateEvent(JSON.stringify(state4));

    await sleep(2000);
  });

  it("should recreate event queue", async () => {
    const now = Date.now();
    const state1 = {"event_type":"state","ts":now-1000,"state_type":"ap_test_type","state_value":0,"state_key":"test_key","labels":{"ok_value":0}};
    await eventhandler.queueStateEvent(JSON.stringify(state1));

    // close the event queue
    const queue = eventhandler.queueMap.get("ap_test_type:test_key");
    await queue.recycle();
    expect(queue.getState()).to.equal('closed');

    const state2 = {"event_type":"state","ts":now,"state_type":"ap_test_type","state_value":1,"state_key":"test_key","labels":{"ok_value":0}};
    await eventhandler.queueStateEvent(JSON.stringify(state2));

    const new_queue = eventhandler.queueMap.get("ap_test_type:test_key");
    expect(new_queue.getState()).to.equal('ready');

    await sleep(500);
  });

  it("should clean up event queue", async () => {
    log.debug(`event queue map size before cleanup: ${eventhandler.queueMap.size}`);
    log.debug(`event queue map items: ${Array.from(eventhandler.queueMap.values()).map(q => `${q.name} (${q.state}/${q.getState()})`).join(', ')}`);

    // close all event queues
    for (const key of eventhandler.queueMap.keys()) {
      const queue = eventhandler.queueMap.get(key);
      await queue.recycle();
      log.debug(`close event queue ${key} (${queue.name}), state ${queue.state}/${queue.getState()}, ts ${queue.lastJobTs}`);
    }

    await eventhandler.cleanupEventQueue();

    for (const key of eventhandler.queueMap.keys()) {
      const queue = eventhandler.queueMap.get(key);
      log.debug(`checked event queue ${key} (${queue.name}), state ${queue.state}/${queue.getState()}, ts ${queue.lastJobTs}`);
    }

    log.debug(`event queue map size after cleanup: ${eventhandler.queueMap.size}`);
    // expect(eventhandler.queueMap.size).to.equal(0);
  });

  it('should check if ap state event', async () => {
    expect(eventhandler.isApStateEvent({"event_type":"state","ts":Date.now(),"state_type":"ap_ethernet_state"})).to.be.true;
    expect(eventhandler.isApStateEvent({"event_type":"state","ts":Date.now(),"state_type":"ap_ethernet_speed_change"})).to.be.true;
    expect(eventhandler.isApStateEvent({"event_type":"state","ts":Date.now(),"state_type":"nic_speed"})).to.be.false;
  });
});

