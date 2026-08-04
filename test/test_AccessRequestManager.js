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
const mock = require('mock-require');

// In-memory redis store (reset between tests)
let store = {};
let sets = {};

// Configurable mock state for approveRequest tests
let mockGetTagByUid = () => null;
let mockLoadedPolicies = [];
let mockPm2UpdateCalled = [];
let mockPm2SaveResult = { policy: { pid: 999 } };
let mockPm2GetPolicyFn = async () => null;
let mockAppTimeUsed = 0;

const mockRclient = {
  getAsync: async (key) => (store[key] !== undefined ? store[key] : null),
  setAsync: async (key, val) => { store[key] = val; },
  delAsync: async (...keys) => { for (const key of keys) { delete store[key]; delete sets[key]; } },
  existsAsync: async (key) => (store[key] !== undefined ? 1 : 0),
  expireAsync: async () => {},
  saddAsync: async (key, val) => { if (!sets[key]) sets[key] = new Set(); sets[key].add(val); },
  sremAsync: async (key, val) => { if (sets[key]) sets[key].delete(val); },
  smembersAsync: async (key) => (sets[key] ? Array.from(sets[key]) : []),
};

mock('../util/redis_manager.js', { getRedisClient: () => mockRclient });
mock('../net2/logger.js', () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }));
mock('../net2/SysManager.js', { getTimezone: () => 'America/New_York' });
mock('../sensor/SensorEventManager.js', { getInstance: () => ({ on: () => {}, emit: () => {} }) });
mock('../net2/TagManager.js', { getTagByUid: (uid) => mockGetTagByUid(uid) });
mock('../net2/Constants.js', {
  REDIS_KEY_APP_TIME_USAGE_CLOUD_CONFIG: 'app_time_usage_cloud_config',
  TAG_TYPE_MAP: {
    user: { ruleTagPrefix: 'userTag:' },
    group: { ruleTagPrefix: 'tag:' },
  },
});
mock('../util/requestWrapper.js', { rrWithErrHandling: async () => ({ body: null }) });

mock('../alarm/PolicyManager2.js', function PolicyManager2() {
  return {
    loadActivePoliciesAsync: async () => mockLoadedPolicies.slice(),
    updatePolicyAsync: async (policy) => { mockPm2UpdateCalled.push(policy); },
    getPolicy: async (pid) => mockPm2GetPolicyFn(pid),
    tryPolicyEnforcement: () => {},
    checkAndSaveAsync: async () => mockPm2SaveResult,
  };
});

mock('../alarm/Policy.js', function Policy(raw) {
  return Object.assign({}, raw);
});

mock('../alarm/AppTimeUsageManager.js', {
  getTimeUsage: async () => mockAppTimeUsed,
});

const {
  getAppFromTarget,
  getAppsFromPolicy,
  matchApp,
  requestKey,
  currentLookupKey,
  AccessRequestManager,
  STATE_PENDING,
  STATE_APPROVED,
  STATE_DENIED,
  STATE_EXPIRED,
  PENDING_SET_KEY,
  ARCHIVED_SET_KEY,
} = require('../alarm/AccessRequestManager.js');


// ─── helpers ──────────────────────────────────────────────────────────────────

function clearStore() {
  store = {};
  sets = {};
}

function makePendingPolicy(overrides = {}) {
  return Object.assign({
    tag: ['userTag:1'],
    action: 'block',
    type: 'category',
    target: 'TLX-fw-youtube',
    appTimeUsage: { quota: 60 },
  }, overrides);
}


// ─── key helpers ─────────────────────────────────────────────────────────────

describe('requestKey / currentLookupKey', () => {
  it('requestKey returns correct prefix', () => {
    expect(requestKey('abc123')).to.equal('access_request:abc123');
  });

  it('currentLookupKey separates userId and app with ::', () => {
    expect(currentLookupKey('user:1', 'youtube')).to.equal('access_request:current:user:1::youtube');
  });

  it('currentLookupKey handles app with colons', () => {
    expect(currentLookupKey('u1', 'a:b:c')).to.equal('access_request:current:u1::a:b:c');
  });
});


// ─── getAppFromTarget ─────────────────────────────────────────────────────────

describe('getAppFromTarget', () => {
  it('strips TLX-fw- prefix', () => {
    expect(getAppFromTarget('TLX-fw-youtube')).to.equal('youtube');
  });

  it('strips TLX-dt- prefix', () => {
    expect(getAppFromTarget('TLX-dt-netflix')).to.equal('netflix');
  });

  it('returns null for non-matching target', () => {
    expect(getAppFromTarget('regular.domain.com')).to.be.null;
  });

  it('returns null for empty string', () => {
    expect(getAppFromTarget('')).to.be.null;
  });

  it('returns empty string for bare prefix', () => {
    expect(getAppFromTarget('TLX-fw-')).to.equal('');
  });
});


// ─── getAppsFromPolicy ────────────────────────────────────────────────────────

describe('getAppsFromPolicy', () => {
  it('returns [] for null policy', () => {
    expect(getAppsFromPolicy(null)).to.deep.equal([]);
  });

  it('returns [] for empty policy', () => {
    expect(getAppsFromPolicy({})).to.deep.equal([]);
  });

  it('returns [internet] for type=internet', () => {
    expect(getAppsFromPolicy({ type: 'internet' })).to.deep.equal(['internet']);
  });

  it('returns [internet] for type=mac', () => {
    expect(getAppsFromPolicy({ type: 'mac' })).to.deep.equal(['internet']);
  });

  it('extracts app from single target', () => {
    expect(getAppsFromPolicy({ target: 'TLX-fw-youtube' })).to.deep.equal(['youtube']);
  });

  it('extracts apps from targets array', () => {
    const result = getAppsFromPolicy({ targets: ['TLX-fw-youtube', 'TLX-dt-netflix'] });
    expect(result).to.deep.equal(['netflix', 'youtube']); // sorted
  });

  it('deduplicates and combines type=internet with app targets', () => {
    const result = getAppsFromPolicy({
      type: 'internet',
      target: 'TLX-fw-youtube',
      targets: ['TLX-dt-netflix'],
    });
    expect(result).to.include('internet');
    expect(result).to.include('youtube');
    expect(result).to.include('netflix');
  });

  it('ignores targets without known prefix', () => {
    expect(getAppsFromPolicy({ target: 'raw.domain.com' })).to.deep.equal([]);
  });
});


// ─── matchApp ─────────────────────────────────────────────────────────────────

describe('matchApp', () => {
  const bypassSchedule = true; // includeNotInScheduleRules
  const includeNonTimeLimit = true;

  it('returns false when policy has no tag', () => {
    const policy = { action: 'block', type: 'category', target: 'TLX-fw-youtube', appTimeUsage: {} };
    expect(matchApp(policy, 'youtube', [], false, bypassSchedule)).to.be.false;
  });

  it('returns false when policy.tag is empty', () => {
    const policy = { tag: [], action: 'block', type: 'category', target: 'TLX-fw-youtube', appTimeUsage: {} };
    expect(matchApp(policy, 'youtube', [], false, bypassSchedule)).to.be.false;
  });

  it('internet type matches app=internet', () => {
    const policy = makePendingPolicy({ type: 'internet', target: undefined, appTimeUsage: { quota: 60 } });
    expect(matchApp(policy, 'internet', [], false, bypassSchedule)).to.be.true;
  });

  it('internet type does not match app=youtube', () => {
    const policy = makePendingPolicy({ type: 'internet', target: undefined, appTimeUsage: { quota: 60 } });
    expect(matchApp(policy, 'youtube', [], false, bypassSchedule)).to.be.false;
  });

  it('internet type matches app=all', () => {
    const policy = makePendingPolicy({ type: 'internet', target: undefined, appTimeUsage: { quota: 60 } });
    expect(matchApp(policy, 'all', [], false, bypassSchedule)).to.be.true;
  });

  it('category type matches target app when supportedApps is empty (no filtering)', () => {
    const policy = makePendingPolicy({ appTimeUsage: { quota: 60 } });
    expect(matchApp(policy, 'youtube', [], false, bypassSchedule)).to.be.true;
  });

  it('category type does not match different app', () => {
    const policy = makePendingPolicy({ appTimeUsage: { quota: 60 } });
    expect(matchApp(policy, 'netflix', [], false, bypassSchedule)).to.be.false;
  });

  it('returns false without appTimeUsage when includeNonTimeLimitRules=false', () => {
    const policy = makePendingPolicy({ appTimeUsage: undefined });
    expect(matchApp(policy, 'youtube', [], false, bypassSchedule)).to.be.false;
  });

  it('returns true without appTimeUsage when includeNonTimeLimitRules=true', () => {
    const policy = makePendingPolicy({ appTimeUsage: undefined });
    expect(matchApp(policy, 'youtube', [], includeNonTimeLimit, bypassSchedule)).to.be.true;
  });

  it('app=all matches any category target', () => {
    const policy = makePendingPolicy({ appTimeUsage: { quota: 60 } });
    expect(matchApp(policy, 'all', [], false, bypassSchedule)).to.be.true;
  });

  it('multi-app string matches policy with matching targets', () => {
    const policy = makePendingPolicy({
      type: 'category',
      target: 'TLX-fw-youtube',
      targets: ['TLX-fw-youtube', 'TLX-dt-netflix'],
      appTimeUsage: { quota: 60 },
    });
    expect(matchApp(policy, 'netflix,youtube', [], false, bypassSchedule)).to.be.true;
  });

  it('multi-app string does not match if counts differ', () => {
    const policy = makePendingPolicy({
      type: 'category',
      target: 'TLX-fw-youtube',
      targets: ['TLX-fw-youtube'],
      appTimeUsage: { quota: 60 },
    });
    expect(matchApp(policy, 'netflix,youtube', [], false, bypassSchedule)).to.be.false;
  });
});


// ─── AccessRequestManager: getBypassPolicyKey ────────────────────────────────

describe('AccessRequestManager.getBypassPolicyKey', () => {
  const mgr = new AccessRequestManager();

  it('returns key with userId and sorted app list', () => {
    expect(mgr.getBypassPolicyKey('user1', ['youtube'])).to.equal('bypass:extraTime:user1:youtube');
    expect(mgr.getBypassPolicyKey('user1', ['netflix', 'youtube'])).to.equal('bypass:extraTime:user1:netflix,youtube');
  });
});


// ─── AccessRequestManager: _getStartOfDayTimestamp / _getEndOfDayTimestamp ───

describe('AccessRequestManager day boundary helpers', () => {
  const mgr = new AccessRequestManager();

  it('_getStartOfDayTimestamp returns timestamp at start of today', () => {
    const ts = mgr._getStartOfDayTimestamp('UTC');
    const now = Math.floor(Date.now() / 1000);
    expect(ts).to.be.at.most(now);
    expect(ts).to.be.above(now - 86400); // within last day
  });

  it('_getEndOfDayTimestamp returns timestamp at end of today', () => {
    const ts = mgr._getEndOfDayTimestamp('UTC');
    const now = Math.floor(Date.now() / 1000);
    expect(ts).to.be.above(now);
    expect(ts).to.be.below(now + 86400); // within next day
  });

  it('start < end', () => {
    const start = mgr._getStartOfDayTimestamp('UTC');
    const end = mgr._getEndOfDayTimestamp('UTC');
    expect(start).to.be.below(end);
  });

  it('falls back to UTC for unknown timezone', () => {
    const ts = mgr._getStartOfDayTimestamp('Invalid/TZ');
    expect(ts).to.be.a('number');
    expect(ts).to.be.above(0);
  });
});


// ─── AccessRequestManager: getRequest ────────────────────────────────────────

describe('AccessRequestManager.getRequest', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('returns null for non-existent key', async () => {
    const result = await mgr.getRequest('nonexistent');
    expect(result).to.be.null;
  });

  it('returns parsed object for existing request', async () => {
    const req = { requestId: 'r1', userId: 'u1', app: 'youtube', state: STATE_PENDING };
    store[requestKey('r1')] = JSON.stringify(req);
    const result = await mgr.getRequest('r1');
    expect(result).to.deep.include({ requestId: 'r1', userId: 'u1', app: 'youtube' });
  });

  it('removes null note field', async () => {
    const req = { requestId: 'r1', note: null, app: 'youtube' };
    store[requestKey('r1')] = JSON.stringify(req);
    const result = await mgr.getRequest('r1');
    expect(result).to.not.have.property('note');
  });

  it('removes "null" string note field', async () => {
    const req = { requestId: 'r1', note: 'null', app: 'youtube' };
    store[requestKey('r1')] = JSON.stringify(req);
    const result = await mgr.getRequest('r1');
    expect(result).to.not.have.property('note');
  });

  it('removes null mac field', async () => {
    const req = { requestId: 'r1', mac: null, app: 'youtube' };
    store[requestKey('r1')] = JSON.stringify(req);
    const result = await mgr.getRequest('r1');
    expect(result).to.not.have.property('mac');
  });

  it('returns null for corrupted JSON', async () => {
    store[requestKey('r1')] = '{not valid json';
    const result = await mgr.getRequest('r1');
    expect(result).to.be.null;
  });
});


// ─── AccessRequestManager: createOrUpdateRequest ─────────────────────────────

describe('AccessRequestManager.createOrUpdateRequest', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('creates a new request with STATE_PENDING', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    expect(req.state).to.equal(STATE_PENDING);
    expect(req.userId).to.equal('u1');
    expect(req.app).to.equal('youtube');
    expect(req.requestQuota).to.equal(30);
    expect(req.leftQuota).to.equal(5);
    expect(req.requestId).to.be.a('string');
  });

  it('saves request to redis and adds to pending set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const raw = store[requestKey(req.requestId)];
    expect(raw).to.exist;
    const members = sets[PENDING_SET_KEY];
    expect(members).to.be.ok;
    expect(Array.from(members)).to.include(req.requestId);
  });

  it('sets lookup key for new request', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const lookupVal = store[currentLookupKey('u1', 'youtube')];
    expect(lookupVal).to.equal(req.requestId);
  });

  it('reuses existing request id when lookup key and request exist', async () => {
    const first = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const second = await mgr.createOrUpdateRequest('u1', 'youtube', 60, 10, {});
    expect(second.requestId).to.equal(first.requestId);
    expect(second.requestQuota).to.equal(60);
  });

  it('preserves createdAt from existing request on update', async () => {
    const first = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const originalCreatedAt = first.createdAt;
    await new Promise(r => setTimeout(r, 10));
    const second = await mgr.createOrUpdateRequest('u1', 'youtube', 60, 10, {});
    expect(second.createdAt).to.equal(originalCreatedAt);
  });

  it('creates new request id when lookup exists but request key is missing', async () => {
    const first = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    // Simulate the request key expiring
    delete store[requestKey(first.requestId)];

    const second = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    expect(second.requestId).to.not.equal(first.requestId);
  });

  it('stores deviceMac and reason from options', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {
      deviceMac: 'AA:BB:CC:DD:EE:FF',
      reason: 'homework done',
    });
    expect(req.deviceMac).to.equal('AA:BB:CC:DD:EE:FF');
    expect(req.reason).to.equal('homework done');
  });

  it('defaults requestQuota/leftQuota to 0 for non-numeric input', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 'bad', undefined, {});
    expect(req.requestQuota).to.equal(0);
    expect(req.leftQuota).to.equal(0);
  });
});


// ─── AccessRequestManager: listPendingRequests ───────────────────────────────

describe('AccessRequestManager.listPendingRequests', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('returns empty array when no pending requests', async () => {
    const result = await mgr.listPendingRequests();
    expect(result).to.deep.equal([]);
  });

  it('returns pending requests', async () => {
    await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.createOrUpdateRequest('u2', 'netflix', 60, 0, {});
    const result = await mgr.listPendingRequests();
    expect(result).to.have.length(2);
    expect(result.every(r => r.state === STATE_PENDING)).to.be.true;
  });

  it('excludes non-pending requests from pending set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    // Manually override the state in the store
    const raw = JSON.parse(store[requestKey(req.requestId)]);
    raw.state = STATE_APPROVED;
    store[requestKey(req.requestId)] = JSON.stringify(raw);

    const result = await mgr.listPendingRequests();
    expect(result).to.have.length(0);
  });
});


// ─── AccessRequestManager: listAllRequests ───────────────────────────────────

describe('AccessRequestManager.listAllRequests', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  async function seedRequest(userId, app, state = STATE_PENDING) {
    const req = await mgr.createOrUpdateRequest(userId, app, 30, 5, {});
    if (state !== STATE_PENDING) {
      const raw = JSON.parse(store[requestKey(req.requestId)]);
      raw.state = state;
      store[requestKey(req.requestId)] = JSON.stringify(raw);
      // Move to archived set
      if (!sets[PENDING_SET_KEY]) sets[PENDING_SET_KEY] = new Set();
      sets[PENDING_SET_KEY].delete(req.requestId);
      if (!sets[ARCHIVED_SET_KEY]) sets[ARCHIVED_SET_KEY] = new Set();
      sets[ARCHIVED_SET_KEY].add(req.requestId);
    }
    return req;
  }

  it('returns all requests when no filter', async () => {
    await seedRequest('u1', 'youtube', STATE_PENDING);
    await seedRequest('u2', 'netflix', STATE_DENIED);
    const result = await mgr.listAllRequests();
    expect(result).to.have.length(2);
  });

  it('filters by state', async () => {
    await seedRequest('u1', 'youtube', STATE_PENDING);
    await seedRequest('u2', 'netflix', STATE_DENIED);
    const result = await mgr.listAllRequests({ state: new Set([STATE_DENIED]) });
    expect(result).to.have.length(1);
    expect(result[0].state).to.equal(STATE_DENIED);
  });

  it('when state=pending only, skips archived set lookup', async () => {
    await seedRequest('u1', 'youtube', STATE_PENDING);
    await seedRequest('u2', 'netflix', STATE_DENIED);
    const result = await mgr.listAllRequests({ state: new Set([STATE_PENDING]) });
    expect(result.every(r => r.state === STATE_PENDING)).to.be.true;
  });

  it('filters by userId', async () => {
    await seedRequest('u1', 'youtube', STATE_PENDING);
    await seedRequest('u2', 'netflix', STATE_PENDING);
    const result = await mgr.listAllRequests({ userId: new Set(['u1']) });
    expect(result).to.have.length(1);
    expect(result[0].userId).to.equal('u1');
  });

  it('filters by app', async () => {
    await seedRequest('u1', 'youtube', STATE_PENDING);
    await seedRequest('u2', 'netflix', STATE_PENDING);
    const result = await mgr.listAllRequests({ app: new Set(['youtube']) });
    expect(result).to.have.length(1);
    expect(result[0].app).to.equal('youtube');
  });

  it('deduplicates requests appearing in both sets', async () => {
    const req = await seedRequest('u1', 'youtube', STATE_PENDING);
    // Manually add the same id to both sets
    if (!sets[ARCHIVED_SET_KEY]) sets[ARCHIVED_SET_KEY] = new Set();
    sets[ARCHIVED_SET_KEY].add(req.requestId);
    const result = await mgr.listAllRequests();
    const ids = result.map(r => r.requestId);
    expect(new Set(ids).size).to.equal(ids.length);
  });
});


// ─── AccessRequestManager: denyRequest ───────────────────────────────────────

describe('AccessRequestManager.denyRequest', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('returns error when request not found', async () => {
    const result = await mgr.denyRequest('nonexistent', 'no reason');
    expect(result.ok).to.be.false;
    expect(result.error).to.match(/not found/i);
  });

  it('returns error when request is not pending', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    // Manually override state
    const raw = JSON.parse(store[requestKey(req.requestId)]);
    raw.state = STATE_APPROVED;
    store[requestKey(req.requestId)] = JSON.stringify(raw);

    const result = await mgr.denyRequest(req.requestId);
    expect(result.ok).to.be.false;
    expect(result.error).to.match(/not pending/i);
  });

  it('sets state to denied and returns ok', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const result = await mgr.denyRequest(req.requestId, 'not now');
    expect(result.ok).to.be.true;
    expect(result.request.state).to.equal(STATE_DENIED);
    expect(result.request.denyReason).to.equal('not now');
  });

  it('removes from pending set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.denyRequest(req.requestId);
    const pendingMembers = sets[PENDING_SET_KEY] || new Set();
    expect(pendingMembers.has(req.requestId)).to.be.false;
  });

  it('adds to archived set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.denyRequest(req.requestId);
    const archivedMembers = sets[ARCHIVED_SET_KEY] || new Set();
    expect(archivedMembers.has(req.requestId)).to.be.true;
  });

  it('deletes lookup key after deny', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.denyRequest(req.requestId);
    expect(store[currentLookupKey('u1', 'youtube')]).to.be.undefined;
  });

  it('does not set denyReason when reason is null/undefined', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const result = await mgr.denyRequest(req.requestId, null);
    expect(result.request).to.not.have.property('denyReason');
  });
});


// ─── AccessRequestManager: expirePendingRequests ─────────────────────────────

describe('AccessRequestManager.expirePendingRequests', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('expires all pending requests', async () => {
    const r1 = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    const r2 = await mgr.createOrUpdateRequest('u2', 'netflix', 60, 0, {});

    await mgr.expirePendingRequests();

    const req1 = await mgr.getRequest(r1.requestId);
    const req2 = await mgr.getRequest(r2.requestId);
    expect(req1.state).to.equal(STATE_EXPIRED);
    expect(req2.state).to.equal(STATE_EXPIRED);
  });

  it('moves expired requests to archived set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.expirePendingRequests();
    expect(sets[ARCHIVED_SET_KEY] && sets[ARCHIVED_SET_KEY].has(req.requestId)).to.be.true;
  });

  it('clears pending set after expiry', async () => {
    await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.expirePendingRequests();
    const pendingMembers = sets[PENDING_SET_KEY] || new Set();
    expect(pendingMembers.size).to.equal(0);
  });

  it('removes stale ids (missing request key) from pending set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    delete store[requestKey(req.requestId)]; // simulate expired key
    await mgr.expirePendingRequests();
    const pendingMembers = sets[PENDING_SET_KEY] || new Set();
    expect(pendingMembers.has(req.requestId)).to.be.false;
  });

  it('removes non-pending entries from pending set without re-archiving', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    // Manually set to approved
    const raw = JSON.parse(store[requestKey(req.requestId)]);
    raw.state = STATE_APPROVED;
    store[requestKey(req.requestId)] = JSON.stringify(raw);

    await mgr.expirePendingRequests();
    const pendingMembers = sets[PENDING_SET_KEY] || new Set();
    expect(pendingMembers.has(req.requestId)).to.be.false;
  });
});


// ─── AccessRequestManager: pruneArchivedSet ──────────────────────────────────

describe('AccessRequestManager.pruneArchivedSet', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('removes stale ids from archived set', async () => {
    if (!sets[ARCHIVED_SET_KEY]) sets[ARCHIVED_SET_KEY] = new Set();
    sets[ARCHIVED_SET_KEY].add('stale-id-1');
    sets[ARCHIVED_SET_KEY].add('stale-id-2');
    // Do not add keys to store — simulates TTL expiry

    await mgr.pruneArchivedSet();
    expect(sets[ARCHIVED_SET_KEY].has('stale-id-1')).to.be.false;
    expect(sets[ARCHIVED_SET_KEY].has('stale-id-2')).to.be.false;
  });

  it('keeps ids whose request keys still exist', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    // Manually add to archived set (simulate already archived)
    if (!sets[ARCHIVED_SET_KEY]) sets[ARCHIVED_SET_KEY] = new Set();
    sets[ARCHIVED_SET_KEY].add(req.requestId);

    await mgr.pruneArchivedSet();
    expect(sets[ARCHIVED_SET_KEY].has(req.requestId)).to.be.true;
  });

  it('does nothing on empty archived set', async () => {
    await mgr.pruneArchivedSet(); // should not throw
  });
});


// ─── AccessRequestManager: listRequestsByUserIds ─────────────────────────────

describe('AccessRequestManager.listRequestsByUserIds', () => {
  const mgr = new AccessRequestManager();

  beforeEach(() => clearStore());

  it('returns only requests for the given userId', async () => {
    await mgr.createOrUpdateRequest('u1', 'youtube', 30, 5, {});
    await mgr.createOrUpdateRequest('u2', 'netflix', 60, 0, {});

    const result = await mgr.listRequestsByUserIds('u1');
    expect(result).to.have.length(1);
    expect(result[0].userId).to.equal('u1');
  });

  it('returns empty array when userId has no requests', async () => {
    const result = await mgr.listRequestsByUserIds('nobody');
    expect(result).to.deep.equal([]);
  });
});


// ─── AccessRequestManager: approveRequest ────────────────────────────────────

describe('AccessRequestManager.approveRequest', () => {
  const mgr = new AccessRequestManager();

  function makeUserTag(uid) {
    return { getTagType: () => 'user', getUniqueId: () => uid };
  }

  function makeBlockPolicy(overrides = {}) {
    return Object.assign({ pid: 100, action: 'block', type: 'mac', tag: ['userTag:u1'] }, overrides);
  }

  beforeEach(() => {
    clearStore();
    mockGetTagByUid = () => null;
    mockLoadedPolicies = [];
    mockPm2UpdateCalled = [];
    mockPm2SaveResult = { policy: { pid: 999 } };
    mockPm2GetPolicyFn = async () => null;
    mockAppTimeUsed = 0;
  });

  it('returns error when request not found', async () => {
    const result = await mgr.approveRequest('nonexistent', 30);
    expect(result.ok).to.be.false;
    expect(result.error).to.match(/not found/i);
  });

  it('returns error when request is not pending', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    const raw = JSON.parse(store[requestKey(req.requestId)]);
    raw.state = STATE_APPROVED;
    store[requestKey(req.requestId)] = JSON.stringify(raw);

    const result = await mgr.approveRequest(req.requestId, 30);
    expect(result.ok).to.be.false;
    expect(result.error).to.match(/not pending/i);
  });

  it('returns error when no matching time limit rules found', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    // TagManager returns null → ruleTagValues empty → no policies match
    const result = await mgr.approveRequest(req.requestId, 30);
    expect(result.ok).to.be.false;
    expect(result.error).to.match(/no time limit rule/i);
  });

  it('sets state to STATE_APPROVED and returns ok', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy()];

    const result = await mgr.approveRequest(req.requestId, 30);
    expect(result.ok).to.be.true;
    expect(result.request.state).to.equal(STATE_APPROVED);
  });

  it('uses requestQuota when approvedQuota is null', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 45, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy()];

    const result = await mgr.approveRequest(req.requestId, null);
    expect(result.ok).to.be.true;
    expect(result.request.approvedQuota).to.equal(45);
  });

  it('uses approvedQuota when explicitly provided', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy()];

    const result = await mgr.approveRequest(req.requestId, 60);
    expect(result.ok).to.be.true;
    expect(result.request.approvedQuota).to.equal(60);
  });

  it('removes from pending set and adds to archived set', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy()];

    await mgr.approveRequest(req.requestId, 30);
    const pending = sets[PENDING_SET_KEY] || new Set();
    const archived = sets[ARCHIVED_SET_KEY] || new Set();
    expect(pending.has(req.requestId)).to.be.false;
    expect(archived.has(req.requestId)).to.be.true;
  });

  it('deletes lookup key after approval', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy()];

    await mgr.approveRequest(req.requestId, 30);
    expect(store[currentLookupKey('u1', 'internet')]).to.be.undefined;
  });

  it('creates bypass policy when affectedPids is non-empty', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy({ pid: 42 })];
    mockPm2SaveResult = { policy: { pid: 888 } };

    await mgr.approveRequest(req.requestId, 30);
    const bypassKey = mgr.getBypassPolicyKey('u1', ['internet']);
    expect(store[bypassKey]).to.equal(888);
  });

  it('updates extraQuota on matching policy when quotaLeft is insufficient', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    // quotaLeft = 60 - 55 = 5, totalQuotaLeft = leftQuota(5) + approvedQuota(30) = 35 → needs 30 extra
    mockLoadedPolicies = [makeBlockPolicy({
      pid: 100,
      appTimeUsage: { quota: 60 },
      appTimeUsed: 55,
    })];

    await mgr.approveRequest(req.requestId, 30);
    const updated = mockPm2UpdateCalled.find(p => p.pid === 100);
    expect(updated).to.exist;
    expect(updated.appTimeUsage.extraQuota).to.equal(30);
  });

  it('resets stale extraQuota to zero when extraQuotaUntilTs has expired', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    const pastTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    // extraQuota=100 is stale (expired); quotaLeft = 60 - 55 = 5, totalQuotaLeft = 35 → needs 30 extra
    mockLoadedPolicies = [makeBlockPolicy({
      pid: 100,
      appTimeUsage: { quota: 60, extraQuota: 100, extraQuotaUntilTs: pastTs },
      appTimeUsed: 55,
    })];

    await mgr.approveRequest(req.requestId, 30);
    const updated = mockPm2UpdateCalled.find(p => p.pid === 100);
    expect(updated).to.exist;
    // stale extraQuota(100) discarded; new value = totalQuotaLeft(35) - quotaLeft(5) = 30
    expect(updated.appTimeUsage.extraQuota).to.equal(30);
  });

  it('skips extraQuota update when quotaLeft is already sufficient', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    const nowTs = Math.floor(Date.now() / 1000);
    // quotaLeft = 60 + 50 - 10 = 100, totalQuotaLeft = 35 → no update needed
    mockLoadedPolicies = [makeBlockPolicy({
      pid: 100,
      appTimeUsage: { quota: 60, extraQuota: 50, extraQuotaUntilTs: nowTs + 3600 },
      appTimeUsed: 10,
    })];

    await mgr.approveRequest(req.requestId, 30);
    expect(mockPm2UpdateCalled.some(p => p.pid === 100)).to.be.false;
  });

  it('reuses existing bypass policy when one is already stored', async () => {
    const req = await mgr.createOrUpdateRequest('u1', 'internet', 30, 5, {});
    mockGetTagByUid = (uid) => uid === 'u1' ? makeUserTag('u1') : null;
    mockLoadedPolicies = [makeBlockPolicy({ pid: 42 })];

    const bypassKey = mgr.getBypassPolicyKey('u1', ['internet']);
    const nowTs = Math.floor(Date.now() / 1000);
    store[bypassKey] = '777';
    mockPm2GetPolicyFn = async (pid) => pid === 777 ? {
      pid: 777,
      appTimeUsage: { quota: 5, extraQuota: 10, extraQuotaUntilTs: nowTs + 3600 },
      appTimeUsed: 0,
    } : null;

    const result = await mgr.approveRequest(req.requestId, 30);
    expect(result.ok).to.be.true;
    // updatePolicyAsync called for the existing bypass policy, not checkAndSaveAsync
    expect(mockPm2UpdateCalled.some(p => p.pid === 777)).to.be.true;
  });
});
