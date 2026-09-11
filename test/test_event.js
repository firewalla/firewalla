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

  it('should check if state event needs the serialized per-key queue', async () => {
    expect(eventhandler.needsSerializedQueue({"event_type":"state","ts":Date.now(),"state_type":"ap_ethernet_state"})).to.be.true;
    expect(eventhandler.needsSerializedQueue({"event_type":"state","ts":Date.now(),"state_type":"ap_ethernet_speed_change"})).to.be.true;
    expect(eventhandler.needsSerializedQueue({"event_type":"state","ts":Date.now(),"state_type":"switch_port_state"})).to.be.true;
    expect(eventhandler.needsSerializedQueue({"event_type":"state","ts":Date.now(),"state_type":"switch_port_speed_change"})).to.be.true;
    expect(eventhandler.needsSerializedQueue({"event_type":"state","ts":Date.now(),"state_type":"switch_connect_state"})).to.be.true;
    expect(eventhandler.needsSerializedQueue({"event_type":"state","ts":Date.now(),"state_type":"nic_speed"})).to.be.false;
  });

  it('should check if state event is error', async () => {
    // no labels, default ok_value 0 applies
    expect(eventhandler.isStateEventError({"state_value":0})).to.be.false;
    expect(eventhandler.isStateEventError({"state_value":1})).to.be.true;
    // explicit ok_value/error_value
    expect(eventhandler.isStateEventError({"state_value":1000,"labels":{"ok_value":1000}})).to.be.false;
    expect(eventhandler.isStateEventError({"state_value":100,"labels":{"ok_value":1000}})).to.be.true;
    expect(eventhandler.isStateEventError({"state_value":1,"labels":{"error_value":1}})).to.be.true;
    expect(eventhandler.isStateEventError({"state_value":2,"labels":{"error_value":1}})).to.be.false;
  });

  it('should check if no_error state event', async () => {
    expect(eventhandler.isNoErrorStateEvent({"state_value":1,"labels":{"no_error":true}})).to.be.true;
    expect(eventhandler.isNoErrorStateEvent({"state_value":1,"labels":{"no_error":false}})).to.be.false;
    expect(eventhandler.isNoErrorStateEvent({"state_value":1,"labels":{"ok_value":0}})).to.be.false;
    expect(eventhandler.isNoErrorStateEvent({"state_value":1})).to.be.false;
  });

  it('should never treat no_error state event as error', async () => {
    // no value is an error, including the ones ok_value/error_value would flag
    expect(eventhandler.isStateEventError({"state_value":0,"labels":{"no_error":true}})).to.be.false;
    expect(eventhandler.isStateEventError({"state_value":1,"labels":{"no_error":true}})).to.be.false;
    expect(eventhandler.isStateEventError({"state_value":2,"labels":{"no_error":true,"error_value":2}})).to.be.false;
    expect(eventhandler.isStateEventError({"state_value":2,"labels":{"no_error":true,"ok_value":0}})).to.be.false;
    // labels are left untouched, no default ok_value injected
    const eventRequest = {"state_value":1,"labels":{"no_error":true}};
    eventhandler.isStateEventError(eventRequest);
    expect(eventRequest.labels).to.deep.equal({"no_error":true});
    // no_error false/absent falls back to the default behavior
    expect(eventhandler.isStateEventError({"state_value":1,"labels":{"no_error":false}})).to.be.true;
  });

  it('should only record state changes of no_error state event', async () => {
    const now = Date.now();
    const stateType = "no_error_test_type"; // NOT an ap_ state event, processed without event queue
    const stateKey = "test_key";
    const cacheKey = `${stateType}:${stateKey}`;
    const labels = {"no_error":true};
    const stateEvent = (ts, value) => JSON.stringify(
      {"event_type":"state","ts":ts,"state_type":stateType,"state_key":stateKey,"state_value":value,"labels":labels});

    // start from a clean state, as if the box has never seen this state event
    await rclient.hdelAsync("event:state:cache", cacheKey);
    await rclient.hdelAsync("event:state:cache:error", cacheKey);

    // initial state is sent as an event
    await eventhandler.queueStateEvent(stateEvent(now-2000, 1));
    expect((await eventapi.getEventByTs(now-2000)).state_value).to.equal(1);

    // repeated state is NOT sent
    await eventhandler.queueStateEvent(stateEvent(now-1000, 1));
    expect(await eventapi.getEventByTs(now-1000)).to.be.empty;

    // changed state is sent, along with the previous value
    await eventhandler.queueStateEvent(stateEvent(now, 2));
    const changed = await eventapi.getEventByTs(now);
    expect(changed.state_value).to.equal(2);
    expect(changed.prev_state_value).to.equal(1);

    // none of them is recorded as an error, and no default ok_value is injected
    expect(await rclient.hgetAsync("event:state:cache:error", cacheKey)).to.be.null;
    const saved = JSON.parse(await rclient.hgetAsync("event:state:cache", cacheKey));
    expect(saved.labels).to.deep.equal({"no_error":true});

    await rclient.zremrangebyscoreAsync("event:log", now-2000, now);
    await rclient.hdelAsync("event:state:cache", cacheKey);
  });
});

