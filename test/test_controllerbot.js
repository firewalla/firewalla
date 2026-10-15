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
'use strict'

const chai = require('chai');
const expect = chai.expect;

const ControllerBot = require('../lib/ControllerBot.js');

// ignoreRecordTracelog does not use `this`, so it can be exercised via the prototype
// without constructing a full ControllerBot (which needs eptcloud/config/groups).
const ignoreRecordTracelog = (data) => ControllerBot.prototype.ignoreRecordTracelog.call({}, data);

describe('Test ControllerBot.ignoreRecordTracelog', function () {
  const mac = "FA:21:C1:54:36:CC";

  describe('fwapc/dap GET or no method', () => {
    it('should ignore fwapc GET', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "GET", path: "/v1/status/ap" } })).to.be.true;
    });

    it('should ignore dap GET', () => {
      expect(ignoreRecordTracelog({ item: "dap", value: { method: "GET", path: "/anything" } })).to.be.true;
    });

    it('should ignore fwapc with no method (defaults to GET)', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { path: "/v1/status/ap" } })).to.be.true;
    });

    it('should ignore lower-case get', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "get", path: "/v1/status/ap" } })).to.be.true;
    });
  });

  describe('read-only style POSTs are ignored', () => {
    const skipCases = [
      `/v1/station_history/${mac}/stats`,
      `/v1/station_history/${mac}/radio`,
      `/v1/station_history/${mac}/preferred_prop`,
      `/v1/config/validate`,
      `/v1/convert_integrated_ap_config`,
      `/v1/control/ping/some-uid-123`,
    ];
    for (const path of skipCases) {
      it(`should ignore POST ${path}`, () => {
        expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path } })).to.be.true;
      });
    }

    it('should ignore for dap item as well', () => {
      expect(ignoreRecordTracelog({ item: "dap", value: { method: "POST", path: `/v1/station_history/${mac}/stats` } })).to.be.true;
    });

    it('should ignore lower-case post method', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "post", path: "/v1/config/validate" } })).to.be.true;
    });

    it('should ignore when path has a query string', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path: "/v1/control/ping/uid?foo=1" } })).to.be.true;
    });

    it('should ignore when path has no v1 prefix', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path: `station_history/${mac}/stats` } })).to.be.true;
    });
  });

  describe('config-changing POSTs are recorded (not ignored)', () => {
    const keepCases = [
      `/v1/control/monitor/${mac}`,
      `/v1/station_history/${mac}`,
      `/v1/config/apply`,
      `/v1/station_history/${mac}/stats/extra`,
    ];
    for (const path of keepCases) {
      it(`should NOT ignore POST ${path}`, () => {
        expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path } })).to.be.false;
      });
    }
  });

  describe('non fwapc/dap and malformed input', () => {
    it('should not ignore a non fwapc/dap item', () => {
      expect(ignoreRecordTracelog({ item: "policy", value: { method: "GET" } })).to.be.false;
    });

    it('should not ignore when data is null', () => {
      expect(ignoreRecordTracelog(null)).to.be.false;
    });

    it('should not ignore when value is missing', () => {
      expect(ignoreRecordTracelog({ item: "fwapc" })).to.be.false;
    });

    it('should not ignore a POST without a matching path', () => {
      expect(ignoreRecordTracelog({ item: "fwapc", value: { method: "POST", path: "/v1/config/apply" } })).to.be.false;
    });
  });
});

// The bone message callback runs from a socket.io event handler, which does not wrap its
// listeners. A synchronous throw out of boneMsgHandler would reach netbot's uncaughtException
// handler, which exits the process and touches managed_reboot - so initEptCloud must contain it.
describe('Test ControllerBot bone message callback', function () {


  // reach the callback initEptCloud hands to pullMsgFromGroup, without a real eptcloud
  function captureBoneCallback(boneMsgHandler) {
    const bot = Object.create(ControllerBot.prototype);
    let captured = null;
    bot.gid = 'g1';
    bot.groups = [{gid: 'g1', me: {displayName: 'box'}, name: 'grp', symmetricKeys: [1, 2]}];
    bot.groupsdb = {};
    bot.fullConfig = {listen: 'all'};
    bot.eptcloud = {
      pullMsgFromGroup: (gid, interval, cb, boneCb) => { captured = boneCb; }
    };
    bot.boneMsgHandler = boneMsgHandler;
    bot.initEptCloud();
    return captured;
  }

  it('passes the message through to boneMsgHandler', function () {
    const seen = [];
    const cb = captureBoneCallback((msg) => seen.push(msg));
    expect(cb).to.be.a('function');
    cb(null, {type: 'CONTROL', control: 'ping'});
    expect(seen).to.deep.equal([{type: 'CONTROL', control: 'ping'}]);
  });

  it('does not throw when boneMsgHandler throws synchronously', function () {
    const cb = captureBoneCallback(() => { throw new Error('boom'); });
    expect(() => cb(null, {type: 'CONTROL', control: 'script'})).to.not.throw();
  });

  it('tolerates no boneMsgHandler at all', function () {
    const cb = captureBoneCallback(undefined);
    expect(() => cb(null, {type: 'CONTROL'})).to.not.throw();
  });
});

// buildMspDataTraceAction does not use `this` either, same prototype trick as above
const buildMspDataTraceAction = (data, prev, msgid) =>
  ControllerBot.prototype.buildMspDataTraceAction.call({}, data, prev, msgid);

describe('Test ControllerBot.buildMspDataTraceAction', function () {
  const eidA = 'It8M_iUtwHnv5qrYWN1VyQ', eidB = '1LmbNM4-LKDb01yisoFN2A';
  const full = () => ({
    config: { alarms: { apply: { default: { state: 'ready' }, large_upload: { state: 'pending' } } } },
    alarmSummary: { create: 0, ignore: 551, review: 7 },
    targetlists: [{ id: 'TL-1', name: 'a', count: 1 }, { id: 'TL-2', name: 'b', count: 2 }],
    mobileAccess: { [eidA]: { profileId: 'full_access' }, [eidB]: { profileId: 'full_access' } },
    plan: 'business', version: '2.12.0', channel: 'official', features: { fireAI: true },
  });
  const msg = (list) => ({ item: 'msp.data', value: { list }, autoTriggered: true });

  it('returns null when nothing changed', () => {
    expect(buildMspDataTraceAction(msg(full()), full(), 'id1')).to.be.null;
  });

  it('records the changed field names and nothing else', () => {
    const next = full();
    next.alarmSummary = { create: 0, ignore: 552, review: 7 };
    const result = buildMspDataTraceAction(msg(next), full(), 'id2');
    expect(result.value.changed).to.deep.equal(['alarmSummary']);
    expect(result.value.list).to.be.undefined;
    expect(result.value.notes).to.be.a('string');
  });

  it('reports every changed field', () => {
    const next = full();
    next.config.alarms.apply.large_upload.state = 'ready';
    next.mobileAccess[eidB] = { profileId: 'limited_access' };
    next.targetlists = [{ id: 'TL-3', name: 'c', count: 3 }];
    const result = buildMspDataTraceAction(msg(next), full(), 'id3');
    expect(result.value.changed.sort()).to.deep.equal(['config', 'mobileAccess', 'targetlists']);
  });

  it('detects a metadata-only target list refresh', () => {
    const next = full();
    next.targetlists[0].count = 100;
    const result = buildMspDataTraceAction(msg(next), full(), 'id4');
    expect(result.value.changed).to.deep.equal(['targetlists']);
  });

  it('keeps the rest of the action untouched', () => {
    const next = full();
    next.plan = 'enterprise';
    const result = buildMspDataTraceAction(msg(next), full(), 'id5');
    expect(result.item).to.equal('msp.data');
    expect(result.autoTriggered).to.be.true;
  });

  it('keeps the other value fields, alias picks the guardian session', () => {
    const next = full();
    next.plan = 'enterprise';
    const action = { item: 'msp.data', value: { list: next, alias: 'secondary' } };
    const result = buildMspDataTraceAction(action, full(), 'id-alias');
    expect(result.value.alias).to.equal('secondary');
    expect(result.value.list).to.be.undefined;
    expect(action.value.alias).to.equal('secondary'); // source not mutated
  });

  it('records the full payload when there is no previous value', () => {
    // first set up after pairing, or the precede record is gone: nothing to diff against
    const action = msg(full());
    expect(buildMspDataTraceAction(action, null, 'id6')).to.equal(action);
  });

  it('records the full payload when the stored value is empty or broken', () => {
    // Guardian.getMspData() returns [] when the stored json fails to parse
    const action = msg(full());
    expect(buildMspDataTraceAction(action, [], 'id7')).to.equal(action);
    expect(buildMspDataTraceAction(action, {}, 'id7b')).to.equal(action);
  });

  it('does not mutate the action or the precede record', () => {
    const next = full(), prev = full();
    next.alarmSummary = { create: 1, ignore: 551, review: 7 };
    const action = msg(next), nextSnapshot = JSON.stringify(next), prevSnapshot = JSON.stringify(prev);
    buildMspDataTraceAction(action, prev, 'id8');
    expect(JSON.stringify(action.value.list)).to.equal(nextSnapshot);
    expect(JSON.stringify(prev)).to.equal(prevSnapshot);
  });
});
