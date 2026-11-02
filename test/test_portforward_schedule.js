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

let store = {};
let appliedRules = [];

const mockRclient = {
  getAsync: async (key) => (store[key] !== undefined ? store[key] : null),
  setAsync: async (key, val) => { store[key] = val; },
};

// records the operation of every rule handed to iptables, '-D' means the rule is removed
const mockRule = (table) => {
  const rule = { table, operation: null };
  const chain = (name) => (...args) => { rule[name] = args; return proxy; };
  const proxy = {
    pro: chain('pro'), dst: chain('dst'), set: chain('set'), dport: chain('dport'),
    dnat: chain('dnat'), jmp: chain('jmp'), chn: chain('chn'),
    opr: (op) => { rule.operation = op; return proxy; },
    _rule: rule,
  };
  return proxy;
};

let mock;
let cacheSnapshot;
let PortForward;

function setupMocks() {
  mock = require('mock-require');
  cacheSnapshot = new Set(Object.keys(require.cache));

  mock('../net2/logger.js', () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} }));
  mock('../net2/Firewalla.js', { isMain: () => false, getRuntimeInfoFolder: () => '/tmp' });
  mock('../util/redis_manager.js', { getRedisClient: () => mockRclient });
  mock('../sensor/SensorEventManager.js', { getInstance: () => ({ on: () => {}, once: () => {}, emit: () => {} }) });
  mock('../net2/SysManager.js', {
    getTimezone: () => 'UTC',
    myWanIps: () => ({ v4: [] }),
    getInterfaceViaIP: () => ({ name: 'eth1', type: 'lan' }),
    inMySubnets4: () => false,
    getDefaultWanInterface: () => null,
    getInterface: () => null,
  });
  mock('../net2/HostTool.js', function HostTool() { return { getMACEntry: async () => null, getMacByIP: async () => null }; });
  mock('../net2/Iptables.js', { Rule: function Rule(table) { return mockRule(table); } });
  mock('../control/IptablesControl.js', { addRule: async (r) => { appliedRules.push(r._rule); } });
  mock('../platform/PlatformLoader.js', { getPlatform: () => ({ isOverlayNetworkAvailable: () => false }) });
  mock('../net2/IdentityManager.js', { getIdentityByGUID: () => null });
  mock('../extension/vpnclient/VPNClient.js', { ensureCreateEnforcementEnv: async () => {}, getSelfIpsetName: () => 'ipset' });
  mock('../net2/NetworkProfile.js', { ensureCreateEnforcementEnv: async () => {}, getSelfIpsetName: () => 'ipset' });
  mock('../net2/Mode.js', { isRouterModeOn: async () => true, MODE_ROUTER: 'router' });

  PortForward = require('../extension/portforward/portforward.js');
}

function restoreMocks() {
  mock.stopAll();
  // only drop modules loaded while the mocks were active, see test_AccessRequestManager.js
  for (const id of Object.keys(require.cache)) {
    if (!cacheSnapshot.has(id)) delete require.cache[id];
  }
}

function makeMap(overrides = {}) {
  return Object.assign({
    protocol: 'tcp',
    dport: 8080,
    toIP: '192.168.1.10',
    toMac: '20:6D:31:00:00:01',
    toPort: 80,
    enabled: true,
    active: true,
  }, overrides);
}

// the port forward singleton is cached in the module, build a fresh state for each test
function newPortForward(maps) {
  const pf = new PortForward();
  pf.config = { maps };
  pf.scheduleCheckTimer = null;
  return pf;
}

const HOUR = 3600;
const now = () => Date.now() / 1000;

describe('PortForward schedule', function () {
  before(() => setupMocks());
  after(() => restoreMocks());
  beforeEach(() => { store = {}; appliedRules = []; });

  describe('validateSchedule', function () {
    it('accepts cronTime with a string duration', function () {
      const map = makeMap({ cronTime: '0 9 * * *', duration: '3600' });
      expect(PortForward.validateSchedule(map)).to.be.null;
      expect(map.cronTime).to.equal('0 9 * * *');
      expect(map.duration).to.equal(3600);
    });

    it('coerces timestamps to numbers and drops empty ones', function () {
      const map = makeMap({ expireTs: String(Math.floor(now()) + 900), idleTs: '' });
      expect(PortForward.validateSchedule(map)).to.be.null;
      expect(map.expireTs).to.be.a('number');
      expect(map).to.not.have.property('idleTs');
    });

    it('rejects a non positive timestamp', function () {
      expect(PortForward.validateSchedule(makeMap({ expireTs: -1 }))).to.be.a('string');
      expect(PortForward.validateSchedule(makeMap({ idleTs: 'soon' }))).to.be.a('string');
    });

    it('rejects an invalid cron expression', function () {
      expect(PortForward.validateSchedule(makeMap({ cronTime: 'every monday', duration: 60 }))).to.be.a('string');
    });

    it('requires duration when cronTime is set, and drops duration without cronTime', function () {
      expect(PortForward.validateSchedule(makeMap({ cronTime: '0 9 * * *' }))).to.be.a('string');
      const map = makeMap({ duration: 60 });
      expect(PortForward.validateSchedule(map)).to.be.null;
      expect(map).to.not.have.property('duration');
    });

    it('normalizes autoDeleteWhenExpires and defaults it to absent, which means true', function () {
      const expireTs = Math.floor(now()) + 900;
      const kept = makeMap({ expireTs, autoDeleteWhenExpires: '0' });
      expect(PortForward.validateSchedule(kept)).to.be.null;
      expect(kept.autoDeleteWhenExpires).to.be.false;

      const deleted = makeMap({ expireTs, autoDeleteWhenExpires: '1' });
      expect(PortForward.validateSchedule(deleted)).to.be.null;
      expect(deleted.autoDeleteWhenExpires).to.be.true;

      const bare = makeMap({ expireTs });
      expect(PortForward.validateSchedule(bare)).to.be.null;
      expect(bare).to.not.have.property('autoDeleteWhenExpires');
    });

    // the app clears an expiry by sending 0; rejecting it would 400 the whole set-policy call
    it('treats 0 as clearing a timestamp rather than as an error', function () {
      const map = makeMap({ expireTs: 0, idleTs: '0' });
      expect(PortForward.validateSchedule(map)).to.be.null;
      expect(map).to.not.have.property('expireTs');
      expect(map).to.not.have.property('idleTs');
    });

    it('drops autoDeleteWhenExpires when there is no expireTs', function () {
      const map = makeMap({ autoDeleteWhenExpires: false });
      expect(PortForward.validateSchedule(map)).to.be.null;
      expect(map).to.not.have.property('autoDeleteWhenExpires');
    });

    it('leaves a plain port forward untouched', function () {
      const map = makeMap();
      expect(PortForward.validateSchedule(map)).to.be.null;
      expect(map).to.deep.equal(makeMap());
    });
  });

  describe('cron window', function () {
    it('reports a port forward inside its window as active', function () {
      const pf = newPortForward([]);
      const map = { cronTime: '0 9 * * *', duration: HOUR };
      // 2026-10-21T09:30:00Z is 30 minutes into the 09:00 window
      const inside = Date.UTC(2026, 9, 21, 9, 30) / 1000;
      expect(pf._inCronWindow(map, inside)).to.be.true;
      expect(pf._isScheduleSuppressed(map, inside)).to.be.false;
    });

    it('reports a port forward outside its window as suppressed', function () {
      const pf = newPortForward([]);
      const map = { cronTime: '0 9 * * *', duration: HOUR };
      const outside = Date.UTC(2026, 9, 21, 10, 30) / 1000;
      expect(pf._inCronWindow(map, outside)).to.be.false;
      expect(pf._isScheduleSuppressed(map, outside)).to.be.true;
    });

    // the schedule timer fires right on the cron boundary, and cron-parser's prev() is strictly
    // before currentDate, so a naive prev() reports the previous window and the start is missed
    it('treats an occurrence exactly at now as the beginning of the window', function () {
      const pf = newPortForward([]);
      const map = { cronTime: '* * * * *', duration: 30 };
      const boundary = Date.UTC(2026, 9, 21, 18, 42, 0) / 1000;
      expect(pf._cronWindowBegin(map, boundary)).to.equal(boundary);
      expect(pf._inCronWindow(map, boundary)).to.be.true;
      expect(pf._inCronWindow(map, boundary - 0.001)).to.be.false;
      expect(pf._inCronWindow(map, boundary + 29)).to.be.true;
      expect(pf._inCronWindow(map, boundary + 30)).to.be.false;
    });

    it('keeps the port closed when the cron expression cannot be parsed', function () {
      const pf = newPortForward([]);
      expect(pf._isScheduleSuppressed({ cronTime: 'nonsense', duration: HOUR }, now())).to.be.true;
    });
  });

  describe('applySchedules', function () {
    const opsOf = (op) => appliedRules.filter(r => r.operation === op);

    it('removes an expired one-time port forward and its iptables rule by default', async function () {
      const map = makeMap({ expireTs: now() - 1 });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(opsOf('-D')).to.have.length.above(0);
      expect(opsOf('-I')).to.have.length(0);
      expect(pf.config.maps).to.have.length(0);
    });

    it('keeps an expired one-time port forward when autoDeleteWhenExpires is false', async function () {
      const map = makeMap({ expireTs: now() - 1, autoDeleteWhenExpires: false });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(opsOf('-D')).to.have.length.above(0);
      expect(pf.config.maps).to.have.length(1);
      expect(map.enabled).to.be.false;
      expect(map).to.not.have.property('expireTs');
    });

    // regression: expireTs and idleTs both elapsed used to re-enable the entry and install its
    // rule in the very same pass that deleted it from the config, orphaning the iptables rule
    it('does not let an elapsed idleTs resurrect an entry that expired in the same pass', async function () {
      const map = makeMap({ expireTs: now() - 1, idleTs: now() - 1 });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(map.enabled).to.be.false;
      expect(pf.config.maps).to.have.length(0);
      expect(opsOf('-I')).to.have.length(0);
    });

    it('only removes the expired entry, leaving the others alone', async function () {
      const expired = makeMap({ dport: 8080, expireTs: now() - 1 });
      const plain = makeMap({ dport: 8081 });
      const pf = newPortForward([expired, plain]);
      await pf.applySchedules();
      expect(pf.config.maps).to.deep.equal([plain]);
    });

    it('keeps a one-time port forward that has not expired yet', async function () {
      const map = makeMap({ expireTs: now() + 900 });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(map.enabled).to.be.true;
      expect(map.expireTs).to.be.a('number');
      expect(opsOf('-D')).to.have.length(0);
    });

    it('resumes a paused port forward once idleTs is reached', async function () {
      const map = makeMap({ enabled: false, idleTs: now() - 1 });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(map.enabled).to.be.true;
      expect(map).to.not.have.property('idleTs');
      expect(opsOf('-I')).to.have.length.above(0);
    });

    it('leaves a port forward paused while idleTs is in the future', async function () {
      const map = makeMap({ enabled: false, idleTs: now() + 900 });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(map.enabled).to.be.false;
      expect(opsOf('-I')).to.have.length(0);
    });

    // regression: this used to depend on a stored flag that said "already off", so a reload
    // landing just after the window closed left the rule installed with nothing to remove it
    it('asserts the rule away whenever the cron window is closed, with no prior state', async function () {
      const map = makeMap({ cronTime: '0 0 1 1 *', duration: 60 });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(opsOf('-D')).to.have.length.above(0);
      expect(map.enabled).to.be.true; // the user facing switch is untouched
      // and again on the next pass: asserting is idempotent, never a one-shot transition
      appliedRules = [];
      await pf.applySchedules();
      expect(appliedRules.filter(r => r.operation === '-D')).to.have.length.above(0);
      expect(appliedRules.filter(r => r.operation === '-I')).to.have.length(0);
    });

    it('asserts the rule in while the cron window is open', async function () {
      const map = makeMap({ cronTime: '* * * * *', duration: HOUR });
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(opsOf('-I')).to.have.length.above(0);
      expect(opsOf('-D')).to.have.length(0);
    });

    it('ignores a port forward without any schedule', async function () {
      const map = makeMap();
      const pf = newPortForward([map]);
      await pf.applySchedules();
      expect(map).to.deep.equal(makeMap());
      expect(appliedRules).to.have.length(0);
    });
  });

  describe('_shouldBeApplied', function () {
    it('is false for a disabled, inactive or suppressed entry', async function () {
      const pf = newPortForward([]);
      expect(await pf._shouldBeApplied(makeMap())).to.be.true;
      expect(await pf._shouldBeApplied(makeMap({ enabled: false }))).to.be.false;
      expect(await pf._shouldBeApplied(makeMap({ active: false }))).to.be.false;
      expect(await pf._shouldBeApplied(makeMap({ idleTs: now() + 900 }))).to.be.false;
      expect(await pf._shouldBeApplied(makeMap({ expireTs: now() - 1 }))).to.be.false;
      expect(await pf._shouldBeApplied(makeMap({ cronTime: '0 0 1 1 *', duration: 60 }))).to.be.false;
    });
  });

  describe('addPort', function () {
    it('does not apply an entry that is outside of its scheduled window', async function () {
      const pf = newPortForward([]);
      await pf.addPort(makeMap({ cronTime: '0 0 1 1 *', duration: 60 }));
      expect(pf.config.maps).to.have.length(1);
      expect(appliedRules).to.have.length(0);
    });

    it('applies an entry that is inside its scheduled window', async function () {
      const pf = newPortForward([]);
      await pf.addPort(makeMap({ cronTime: '* * * * *', duration: HOUR }));
      expect(appliedRules.filter(r => r.operation === '-I')).to.have.length.above(0);
    });

    it('does not treat a schedule change on an existing entry as a duplicate', async function () {
      const pf = newPortForward([makeMap({ expireTs: 1000 })]);
      await pf.addPort(makeMap({ expireTs: 2000 }));
      expect(pf.config.maps).to.have.length(1);
      expect(pf.config.maps[0].expireTs).to.equal(2000);
    });

    // regression: (old || null) !== (new || null) folded false and undefined together, so
    // "keep the entry at expiry" was silently discarded and the entry got deleted instead
    it('treats turning autoDeleteWhenExpires off as a schedule change', async function () {
      const expireTs = Math.floor(now()) + 900;
      const pf = newPortForward([makeMap({ expireTs })]);
      expect(pf._scheduleChanged(pf.config.maps[0], makeMap({ expireTs, autoDeleteWhenExpires: false }))).to.be.true;
      await pf.addPort(makeMap({ expireTs, autoDeleteWhenExpires: false }));
      expect(pf.config.maps).to.have.length(1);
      expect(pf.config.maps[0].autoDeleteWhenExpires).to.be.false;
    });
  });

  describe('_getNextScheduleTs', function () {
    it('returns the nearest future boundary across all entries', function () {
      const base = Math.floor(now());
      const pf = newPortForward([
        makeMap({ dport: 8080, expireTs: base + 900 }),
        makeMap({ dport: 8081, idleTs: base + 300 }),
        makeMap({ dport: 8082 }),
      ]);
      expect(pf._getNextScheduleTs(base)).to.equal(base + 300);
    });

    it('returns null when nothing is scheduled', function () {
      const pf = newPortForward([makeMap()]);
      expect(pf._getNextScheduleTs()).to.be.null;
    });

    it('returns the end of the window when now is exactly on the cron boundary', function () {
      const boundary = Date.UTC(2026, 9, 21, 18, 42, 0) / 1000;
      const pf = newPortForward([makeMap({ cronTime: '* * * * *', duration: 30 })]);
      expect(pf._getNextScheduleTs(boundary)).to.equal(boundary + 30);
    });

    it('returns the end of the current cron window', function () {
      const inside = Date.UTC(2026, 9, 21, 9, 30) / 1000;
      const pf = newPortForward([makeMap({ cronTime: '0 9 * * *', duration: HOUR })]);
      expect(pf._getNextScheduleTs(inside)).to.equal(Date.UTC(2026, 9, 21, 10, 0) / 1000);
    });
  });
});
