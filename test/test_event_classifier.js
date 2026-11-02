/*    Copyright 2026 Firewalla LLC
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

const eventClassifier = require('../event/EventClassifier.js');
const eventApi = require('../event/EventApi.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

const KEY_EVENT_LAST_CACHE = "event:last:cache";
const FALLBACK_SETTINGS = eventClassifier.FALLBACK_SETTINGS;
// the type-specific rules ship here, not in the code - the cloud replaces this array wholesale
const SHIPPED_SETTINGS = require('../net2/config.json').sensors.EventSensor.eventClassifierSettings;

const stateEvent = (ts, stateValue, stateKey = "k1", stateType = "test_state_type") =>
  ({ ts, event_type: "state", state_type: stateType, state_key: stateKey, state_value: stateValue });

const actionEvent = (ts, actionValue, actionType = "test_action_type") =>
  ({ ts, event_type: "action", action_type: actionType, action_value: actionValue });

describe('Test event classifier', function() {
  beforeEach(() => {
    // classify() reads this.settings on top of the built-in fallback, clear it between cases
    eventClassifier.settings = [];
  });

  describe('classify', () => {
    it('should key a state event on state_type, state_key and state_value', () => {
      expect(eventClassifier.classify(stateEvent(1, 0)))
        .to.equal('state::["test_state_type","k1",0]');
    });

    it('should give a different key when any of the three state fields differs', () => {
      const base = eventClassifier.classify(stateEvent(1, 0));
      expect(eventClassifier.classify(stateEvent(2, 1))).to.not.equal(base);
      expect(eventClassifier.classify(stateEvent(2, 0, "k2"))).to.not.equal(base);
      expect(eventClassifier.classify(stateEvent(2, 0, "k1", "other_type"))).to.not.equal(base);
      // same three fields at a different ts is the SAME type
      expect(eventClassifier.classify(stateEvent(99, 0))).to.equal(base);
    });

    it('should key an action event on action_type only', () => {
      expect(eventClassifier.classify(actionEvent(1, 5)))
        .to.equal('action::["test_action_type"]');
      // action_value is not part of the key
      expect(eventClassifier.classify(actionEvent(2, 9)))
        .to.equal(eventClassifier.classify(actionEvent(1, 5)));
    });

    it('should hardcode only the two catch-alls as the fallback', () => {
      expect(FALLBACK_SETTINGS.map(s => [s.key, s.eventKeys])).to.deep.equal([
        ["state", ["state_type", "state_key", "state_value"]],
        ["action", ["action_type"]]
      ]);
    });

    it('should ship type-specific defaults in net2/config.json that all validate', () => {
      const valid = eventClassifier._validateSettings(SHIPPED_SETTINGS);
      expect(valid.length).to.equal(SHIPPED_SETTINGS.length);
      expect(valid.map(s => s.key)).to.deep.equal(["wan_monitor", "weak_password_scan_complete"]);
    });

    it('should key wan monitor actions on action_type and the WAN uuid', () => {
      eventClassifier.settings = eventClassifier._validateSettings(SHIPPED_SETTINGS);
      const rtt = (type, uuid) => ({ ts: 1, event_type: "action", action_type: type, action_value: 1,
        labels: { target: "1.1.1.1", rtt: 20, wan_intf_uuid: uuid, wan_intf_name: "eth0" } });
      for (const type of ["ping_RTT", "dns_RTT", "http_RTT", "ping_lossrate", "dns_lossrate", "http_lossrate"])
        expect(eventClassifier.classify(rtt(type, "UUID-A"))).to.equal(`wan_monitor::["${type}","UUID-A"]`);
      // a second WAN keeps its own lineage
      expect(eventClassifier.classify(rtt("ping_RTT", "UUID-B")))
        .to.not.equal(eventClassifier.classify(rtt("ping_RTT", "UUID-A")));
      // NetworkMonitorSensor only sets the WAN labels when it resolved an intfObj
      expect(eventClassifier.classify({ ts: 1, event_type: "action", action_type: "ping_RTT", labels: { target: "x" } }))
        .to.equal('wan_monitor::["ping_RTT",null]');
      // an action type outside the list is left on the generic rule
      expect(eventClassifier.classify({ ts: 1, event_type: "action", action_type: "speed_test",
        labels: { wan_intf_uuid: "UUID-A" } })).to.equal('action::["speed_test"]');
    });

    it('should key weak_password_scan_complete on the found flag', () => {
      eventClassifier.settings = eventClassifier._validateSettings(SHIPPED_SETTINGS);
      const scan = (found) => ({ ts: 1, event_type: "action", action_type: "weak_password_scan_complete",
        action_value: 1, labels: { key: "cron_1", trigger: "cron", numOfHosts: 3,
          numOfWeakPasswords: found ? 2 : 0, found: found ? 1 : 0 } });
      expect(eventClassifier.classify(scan(true)))
        .to.equal('weak_password_scan_complete::["weak_password_scan_complete",1]');
      expect(eventClassifier.classify(scan(false)))
        .to.equal('weak_password_scan_complete::["weak_password_scan_complete",0]');
      // the start event is not covered by the specific rule
      expect(eventClassifier.classify({ ts: 1, event_type: "action", action_type: "weak_password_scan_start",
        labels: { key: "cron_1" } })).to.equal('action::["weak_password_scan_start"]');
    });

    it('should return null only for an event that is neither state nor action', () => {
      expect(eventClassifier.classify({ ts: 1, event_type: "something_else" })).to.be.null;
      expect(eventClassifier.classify({ ts: 1 })).to.be.null;
      expect(eventClassifier.classify(null)).to.be.null;
    });

    it('should fall back to the catch-alls when no configured setting matches', () => {
      eventClassifier.settings = eventClassifier._validateSettings([{
        key: "ap", filter: { field: "state_type", value: "ap_ethernet_state" }, eventKeys: ["state_key"]
      }]);
      // not an ap_ethernet_state event, so the configured setting does not match
      expect(eventClassifier.classify(stateEvent(1, 0)))
        .to.equal('state::["test_state_type","k1",0]');
      expect(eventClassifier.classify(actionEvent(1, 5)))
        .to.equal('action::["test_action_type"]');
      // ...but the configured setting still wins for what it does match
      const ap = { ts: 1, event_type: "state", state_type: "ap_ethernet_state", state_key: "p1", state_value: 1 };
      expect(eventClassifier.classify(ap)).to.equal('ap::["p1"]');
    });

    it('should fall back to the catch-alls when there are no settings at all', () => {
      eventClassifier.settings = [];
      expect(eventClassifier.classify(stateEvent(1, 0)))
        .to.equal('state::["test_state_type","k1",0]');
      expect(eventClassifier.classify(actionEvent(1, 5)))
        .to.equal('action::["test_action_type"]');
    });

    it('should let a narrowing setting shadow a catch-all without disabling it', () => {
      eventClassifier.settings = eventClassifier._validateSettings([{
        key: "narrow", filter: { field: "event_type", value: "state" }, eventKeys: ["state_type"]
      }]);
      expect(eventClassifier.classify(stateEvent(1, 0))).to.equal('narrow::["test_state_type"]');
      // actions were not covered by the setting, so they stay on the catch-all
      expect(eventClassifier.classify(actionEvent(1, 5))).to.equal('action::["test_action_type"]');
    });

    it('should resolve labelKeys from event.labels', () => {
      eventClassifier.settings = eventClassifier._validateSettings([{
        key: "ap", filter: { field: "state_type", value: "ap_ethernet_state" },
        eventKeys: ["state_value"], labelKeys: ["ap_mac", "intf"]
      }]);
      const ev = { ts: 1, event_type: "state", state_type: "ap_ethernet_state", state_key: "x",
        state_value: 1, labels: { ap_mac: "AA:BB", intf: "eth0" } };
      expect(eventClassifier.classify(ev)).to.equal('ap::[1,"AA:BB","eth0"]');
      // a different AP is a different type even though the outer fields are identical
      const ev2 = Object.assign({}, ev, { labels: { ap_mac: "CC:DD", intf: "eth0" } });
      expect(eventClassifier.classify(ev2)).to.not.equal(eventClassifier.classify(ev));
    });

    it('should coerce a missing or non-primitive field to null rather than dropping it', () => {
      // state_key absent -> null placeholder, NOT collapsed with a shorter tuple
      const missing = eventClassifier.classify(
        { ts: 1, event_type: "state", state_type: "t", state_value: 0 });
      expect(missing).to.equal('state::["t",null,0]');
      // an object value would make JSON.stringify key order load-bearing
      const obj = eventClassifier.classify(
        { ts: 1, event_type: "state", state_type: "t", state_key: { a: 1 }, state_value: 0 });
      expect(obj).to.equal('state::["t",null,0]');
    });

    it('should let the first matching setting win', () => {
      eventClassifier.settings = eventClassifier._validateSettings([
        { key: "specific", filter: { and: [ { field: "event_type", value: "state" },
          { field: "state_type", value: "test_state_type" } ] }, eventKeys: ["state_key"] },
        { key: "generic", filter: { field: "event_type", value: "state" }, eventKeys: ["state_type"] }
      ]);
      expect(eventClassifier.classify(stateEvent(1, 0))).to.equal('specific::["k1"]');
      expect(eventClassifier.classify(stateEvent(1, 0, "k1", "another"))).to.equal('generic::["another"]');
    });
  });

  describe('_validateSettings', () => {
    const good = { key: "ok", filter: { field: "event_type", value: "state" }, eventKeys: ["state_type"] };

    it('should keep a valid setting and normalize the key lists', () => {
      const valid = eventClassifier._validateSettings([good]);
      expect(valid.length).to.equal(1);
      expect(valid[0].eventKeys).to.deep.equal(["state_type"]);
      expect(valid[0].labelKeys).to.deep.equal([]);
    });

    it('should drop only the offending setting', () => {
      const bad = [
        { filter: good.filter, eventKeys: ["a"] },                        // no key
        { key: "nofilter", eventKeys: ["a"] },                            // no filter
        { key: "notarray", filter: good.filter, eventKeys: "a" },         // non-array
        { key: "notstring", filter: good.filter, eventKeys: [1] },        // non-string
        { key: "empty", filter: good.filter },                            // no keys at all
        { key: "emptystring", filter: good.filter, eventKeys: [""] },     // empty string key
      ];
      for (const b of bad) {
        const valid = eventClassifier._validateSettings([b, good]);
        expect(valid.length, JSON.stringify(b)).to.equal(1);
        expect(valid[0].key).to.equal("ok");
      }
    });

    it('should tolerate a non-array settings value', () => {
      expect(eventClassifier._validateSettings(null)).to.deep.equal([]);
      expect(eventClassifier._validateSettings({ key: "x" })).to.deep.equal([]);
    });
  });
});

describe('Test last_ts on event:log', function() {
  this.timeout(10000);

  const TYPE = "test_last_ts_type";
  const written = [];

  const add = async (event) => {
    written.push(event.ts);
    await eventApi.addEvent(event, event.ts);
    return eventApi.getEventByTs(event.ts);
  };

  // only ever touch this suite's own fields - these keys are live on a box
  const cleanup = async () => {
    for (const ts of written.splice(0)) await rclient.zremrangebyscoreAsync("event:log", ts, ts);
    const fields = await rclient.hkeysAsync(KEY_EVENT_LAST_CACHE);
    const mine = (fields || []).filter(f => f.includes(TYPE));
    if (mine.length) await rclient.hdelAsync(KEY_EVENT_LAST_CACHE, ...mine);
  };

  beforeEach(async () => {
    eventClassifier.settings = [];
    await cleanup();
  });

  afterEach(cleanup);

  it('should set last_ts to null on the first event of a type', async () => {
    const now = Date.now();
    const saved = await add(stateEvent(now, 0, "k1", TYPE));
    expect(saved.last_ts).to.be.null;
  });

  it('should set last_ts to the previous event of the same type', async () => {
    const now = Date.now();
    await add(stateEvent(now - 2000, 0, "k1", TYPE));
    const second = await add(stateEvent(now, 0, "k1", TYPE));
    expect(second.last_ts).to.equal(now - 2000);
  });

  it('should keep types independent', async () => {
    const now = Date.now();
    await add(stateEvent(now - 2000, 0, "k1", TYPE));
    // different state_value -> different type under the default rule
    const other = await add(stateEvent(now - 1000, 1, "k1", TYPE));
    expect(other.last_ts).to.be.null;
    const third = await add(stateEvent(now, 0, "k1", TYPE));
    expect(third.last_ts).to.equal(now - 2000);
  });

  it('should never report a last_ts newer than the event itself', async () => {
    const now = Date.now();
    await add(stateEvent(now, 0, "k1", TYPE));
    // arrives late, out of order - its only candidate is newer than itself
    const late = await add(stateEvent(now - 5000, 0, "k1", TYPE));
    expect(late.last_ts).to.be.null;
  });

  it('should not let a late older event roll the cache backwards', async () => {
    const now = Date.now();
    await add(stateEvent(now - 1000, 0, "k1", TYPE));
    await add(stateEvent(now - 5000, 0, "k1", TYPE)); // out of order
    const next = await add(stateEvent(now, 0, "k1", TYPE));
    expect(next.last_ts).to.equal(now - 1000);
  });

  it('should add no last_ts field at all when nothing classifies', async () => {
    const now = Date.now();
    const saved = await add({ ts: now, event_type: "unclassified_type" });
    expect(saved).to.not.have.property('last_ts');
  });

  it('should not mutate the object it was given', async () => {
    const now = Date.now();
    const event = stateEvent(now, 0, "k1", TYPE);
    written.push(now);
    await eventApi.addEvent(event, now);
    expect(event).to.not.have.property('last_ts');
  });

  it('should keep the latest event of each type in the cache', async () => {
    const now = Date.now();
    await add(stateEvent(now - 2000, 0, "k1", TYPE));
    await add(stateEvent(now, 0, "k1", TYPE));
    const field = `state::${JSON.stringify([TYPE, "k1", 0])}`;
    const cached = JSON.parse(await rclient.hgetAsync(KEY_EVENT_LAST_CACHE, field));
    expect(cached.ts).to.equal(now);
    expect(cached.last_ts).to.equal(now - 2000);
  });

  it('should list only types whose latest event predates the cutoff, newest first', async () => {
    const now = Date.now();
    const DAY = 86400000;
    await add(stateEvent(now - 3 * DAY, 0, "k1", TYPE));
    await add(stateEvent(now - 2 * DAY, 0, "k1", TYPE)); // same type again, so it gets a last_ts
    await add(stateEvent(now - 5 * DAY, 1, "k1", TYPE)); // a second type, seen once
    await add(stateEvent(now - 3600, 2, "k1", TYPE));    // a third type, inside the window

    // limit -1: a live box's cache may hold more than the default cap of stale types, which would
    // truncate this suite's own entries out of the result
    const before = (await eventApi.listLastEventsBefore(now - DAY, -1)).filter(e => e.state_type === TYPE);
    expect(before.map(e => e.ts)).to.deep.equal([now - 2 * DAY, now - 5 * DAY]);
    // the whole event is returned, last_ts included, so the app can chain one step further back
    expect(before[0].last_ts).to.equal(now - 3 * DAY);
    expect(before[1].last_ts).to.be.null;
    expect(before[0].state_type).to.equal(TYPE);
    // the type still active inside the window is not repeated here
    expect(before.some(e => e.state_value === 2)).to.be.false;
  });

  it('should treat the listLastEventsBefore cutoff as exclusive', async () => {
    const now = Date.now();
    const DAY = 86400000;
    await add(stateEvent(now - 3 * DAY, 0, "k1", TYPE));
    await add(stateEvent(now - 5 * DAY, 1, "k1", TYPE));
    const mine = (list) => list.filter(e => e.state_type === TYPE).map(e => e.ts);
    // an entry whose ts equals the cutoff is excluded
    expect(mine(await eventApi.listLastEventsBefore(now - 3 * DAY, -1))).to.deep.equal([now - 5 * DAY]);
    expect(mine(await eventApi.listLastEventsBefore(now - 6 * DAY, -1))).to.deep.equal([]);
  });

  it('should expire cached types by time', async () => {
    const now = Date.now();
    await add(stateEvent(now - 2000, 0, "k1", TYPE));
    const field = `state::${JSON.stringify([TYPE, "k1", 0])}`;
    expect(await rclient.hgetAsync(KEY_EVENT_LAST_CACHE, field)).to.not.be.null;
    // cleanLatestStateEventsByTime() wires this same helper onto KEY_EVENT_LAST_CACHE, but it
    // also sweeps the live event:state:cache keys, so exercise the helper directly here
    await eventApi.cleanCachedEventsByTime(KEY_EVENT_LAST_CACHE, now);
    expect(await rclient.hgetAsync(KEY_EVENT_LAST_CACHE, field)).to.be.null;
  });
});
