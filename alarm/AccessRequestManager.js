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

const rclient = require('../util/redis_manager.js').getRedisClient();
const log = require('../net2/logger.js')(__filename);
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

const REQUEST_KEY_PREFIX = 'access_request:';
const CURRENT_LOOKUP_PREFIX = 'access_request:current:';
const PENDING_SET_KEY = 'access_request:pending';
const ARCHIVED_SET_KEY = 'access_request:archived';
const CURRENT_LOOKUP_SEP = '::'; // userId::app so colons in userId/app don't break parsing

const STATE_PENDING = 'pending';
const STATE_APPROVED = 'approved';
const STATE_DENIED = 'denied';
const STATE_EXPIRED = 'expired';

const ARCHIVE_TTL_SECONDS = 7 * 24 * 3600; // 7 days

function requestKey(requestId) {
  return REQUEST_KEY_PREFIX + requestId;
}

function currentLookupKey(userId, app) {
  return CURRENT_LOOKUP_PREFIX + userId + CURRENT_LOOKUP_SEP + app;
}

/**
 * Get user tag and its affiliated tag for a given user id.
 * @param {string} userId - user tag uid
 * @returns {{ user: object|null, afTag: object|null }}
 */
function getUserRelatedTags(userId) {
  if (!userId) return { user: null, afTag: null };
  const TagManager = require('../net2/TagManager.js');
  const user = TagManager.getTagByUid(userId);
  if (!user) return { user: null, afTag: null };
  const afTag = user.afTag || (user.o && user.o.affiliatedTag && TagManager.getTagByUid(user.o.affiliatedTag)) || null;
  return { user, afTag };
}

/**
 * Find time-limit policies that match the given userId and optionally app.
 * Uses getUserRelatedTags to get user and affiliated tag, then matches policy.tag to their rule tag values (e.g. userTag:uid, tag:uid).
 * When app is omitted, returns all policies that match the user (any app).
 * Paused rule is also returned
 * @param {string|null} userId - user tag uid
 * @param {string} [app] - optional app/category key; when omitted, all matching policies are returned
 * @returns {Promise<Array>} matching policies
 */
async function findMatchingTimeLimitRules(userId, app) {
  const Constants = require('../net2/Constants.js');
  const { user, afTag } = getUserRelatedTags(userId || '');
  const ruleTagValues = new Set();
  const addRuleTag = (tag) => {
    if (!tag || !tag.getTagType) return;
    const prefix = Constants.TAG_TYPE_MAP[tag.getTagType()] && Constants.TAG_TYPE_MAP[tag.getTagType()].ruleTagPrefix;
    const uid = tag.getUniqueId && tag.getUniqueId();
    if (prefix && uid != null) ruleTagValues.add(prefix + uid);
  };
  addRuleTag(user);
  addRuleTag(afTag);

  const PolicyManager2 = require('./PolicyManager2.js');
  const pm2 = new PolicyManager2();
  const allPolicies = await pm2.loadActivePoliciesAsync({ includingDisabled: 1 });
  const matchApp = (p) => {
    if (!p.appTimeUsage || !p.tag || p.tag.length === 0) return false;
    if (!app) return true;
    const au = p.appTimeUsage;
    if (au.app && au.app === app) return true;
    if (Array.isArray(au.apps) && au.apps.includes(app)) return true;
    return false;
  };
  const policyTargetsUserOrGroup = (p) => p.tag && p.tag.some(t => ruleTagValues.has(t));
  return allPolicies.filter(p => matchApp(p) && policyTargetsUserOrGroup(p));
}

class AccessRequestManager {
  /**
   * Create or update an access request. If a pending request exists for (userId, app), reuse its id and overwrite.
   * @param {string} userId - user tag uid
   * @param {string} app - app/category key
   * @param {number} requestQuota - minutes requested
   * @param {object} options - { deviceMac, reason }
   * @returns {Promise<object>} request object with requestId
   */
  async createOrUpdateRequest(userId, app, requestQuota, options = {}) {
    const lookupKey = currentLookupKey(userId, app);
    let requestId = await rclient.getAsync(lookupKey);
    if (requestId) {
      const exists = await rclient.existsAsync(requestKey(requestId));
      if (!exists) {
        await rclient.delAsync(lookupKey);
        requestId = null;
      }
    }

    const now = Date.now() / 1000;
    const request = {
      requestId: requestId || require('uuid').v4(),
      userId,
      app,
      requestQuota: Number(requestQuota) || 0,
      requestTs: now,
      state: STATE_PENDING,
      deviceMac: options.deviceMac || null,
      reason: options.reason || null,
      createdAt: options.createdAt || now,
      updatedAt: now
    };

    if (!requestId) {
      requestId = request.requestId;
      await rclient.setAsync(requestKey(requestId), JSON.stringify(request));
      await rclient.saddAsync(PENDING_SET_KEY, requestId);
      await rclient.setAsync(lookupKey, requestId);
    } else {
      const existingRaw = await rclient.getAsync(requestKey(requestId));
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          request.requestId = requestId;
          if (existing.createdAt != null) request.createdAt = existing.createdAt;
        } catch (_e) { /* ignore */ }
      }
      await rclient.setAsync(requestKey(requestId), JSON.stringify(request));
    }

    return request;
  }

  async getRequest(requestId) {
    const raw = await rclient.getAsync(requestKey(requestId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      log.error('AccessRequestManager getRequest parse error', requestId, e.message);
      return null;
    }
  }

  /**
   * List request ids in pending set, then fetch each request (filters to pending only).
   */
  async listPendingRequests() {
    const ids = await rclient.smembersAsync(PENDING_SET_KEY);
    const list = [];
    for (const id of ids) {
      const req = await this.getRequest(id);
      if (req && req.state === STATE_PENDING) list.push(req);
    }
    return list;
  }

  /**
   * List access requests for a given user id. Delegates to listAllRequests with filter.userId set.
   * @param {string|null} userId - user tag uid (at most one)
   * @param {object} [filter] - optional filter (state, app as Sets); merged with userId filter
   * @returns {Promise<object[]>}
   */
  async listRequestsByUserIds(userId, filter = {}) {
    const mergedFilter = Object.assign({}, filter, { userId: userId != null ? new Set([userId]) : new Set() });
    return this.listAllRequests(mergedFilter);
  }

  /**
   * List all access requests (for admin). Uses pending and archived sets only (no scan).
   * Filter values are Sets: filter.state, filter.userId, filter.app.
   * When filter.state only contains "pending", only PENDING_SET_KEY is traversed (not archived).
   */
  async listAllRequests(filter = {}) {
    const stateSet = filter.state;
    const onlyPending = stateSet && stateSet.size === 1 && stateSet.has(STATE_PENDING);
    const noPending = stateSet && !stateSet.has(STATE_PENDING);

    const pendingIds = noPending ? [] : await rclient.smembersAsync(PENDING_SET_KEY);
    const archivedIds = onlyPending ? [] : await rclient.smembersAsync(ARCHIVED_SET_KEY);
    const seen = new Set();
    const list = [];
    for (const requestId of [...pendingIds, ...archivedIds]) {
      if (seen.has(requestId)) continue;
      seen.add(requestId);
      const req = await this.getRequest(requestId);
      if (!req) continue;
      if (stateSet && !stateSet.has(req.state)) continue;
      if (filter.userId && !filter.userId.has(req.userId)) continue;
      if (filter.app && !filter.app.has(req.app)) continue;
      list.push(req);
    }
    return list;
  }

  /**
   * Approve an access request: find matching rules, update extraQuota on each, reenforce each, then mark request approved.
   */
  async approveRequest(requestId, approvedQuota) {
    const req = await this.getRequest(requestId);
    if (!req) return { ok: false, error: 'Request not found' };
    if (req.state !== STATE_PENDING) return { ok: false, error: 'Request is not pending' };

    const PolicyManager2 = require('./PolicyManager2.js');
    const sysManager = require('../net2/SysManager.js');
    const pm2 = new PolicyManager2();

    const matchingPolicies = await findMatchingTimeLimitRules(req.userId, req.app);
    if (matchingPolicies.length === 0) {
      return { ok: false, error: 'No time limit rule found for this user and app' };
    }

    const minutes = approvedQuota != null ? Number(approvedQuota) : Number(req.requestQuota) || 0;
    const tz = sysManager.getTimezone();
    const endOfTodayTs = this._getEndOfDayTimestamp(tz);
    const nowTs = Date.now() / 1000;

    for (const policy of matchingPolicies) {
      const au = Object.assign({}, policy.appTimeUsage);
      if (au.extraQuotaUntilTs != null && nowTs < au.extraQuotaUntilTs) {
        au.extraQuota = (Number(au.extraQuota) || 0) + minutes;
      } else {
        au.extraQuota = minutes;
      }
      au.extraQuotaUntilTs = endOfTodayTs;

      const oldPolicy = policy;
      await pm2.updatePolicyAsync({ pid: policy.pid, appTimeUsage: au });
      const updatedPolicy = await pm2.getPolicy(policy.pid);
      if (updatedPolicy) {
        pm2.tryPolicyEnforcement(updatedPolicy, 'reenforce', oldPolicy);
      }
    }

    req.state = STATE_APPROVED;
    req.updatedAt = Date.now() / 1000;
    req.approvedQuota = minutes;
    await rclient.setAsync(requestKey(requestId), JSON.stringify(req));
    await rclient.expireAsync(requestKey(requestId), ARCHIVE_TTL_SECONDS);
    await rclient.sremAsync(PENDING_SET_KEY, requestId);
    await rclient.saddAsync(ARCHIVED_SET_KEY, requestId);
    await rclient.delAsync(currentLookupKey(req.userId, req.app));

    return { ok: true, request: req };
  }

  /**
   * Deny an access request.
   */
  async denyRequest(requestId, reason) {
    const req = await this.getRequest(requestId);
    if (!req) return { ok: false, error: 'Request not found' };
    if (req.state !== STATE_PENDING) return { ok: false, error: 'Request is not pending' };

    req.state = STATE_DENIED;
    req.updatedAt = Date.now() / 1000;
    if (reason != null) req.denyReason = reason;
    await rclient.setAsync(requestKey(requestId), JSON.stringify(req));
    await rclient.expireAsync(requestKey(requestId), ARCHIVE_TTL_SECONDS);
    await rclient.sremAsync(PENDING_SET_KEY, requestId);
    await rclient.saddAsync(ARCHIVED_SET_KEY, requestId);
    await rclient.delAsync(currentLookupKey(req.userId, req.app));

    return { ok: true, request: req };
  }

  /**
   * Remove from the archived set any request ids whose key no longer exists (e.g. expired after 7-day TTL).
   */
  async pruneArchivedSet() {
    const ids = await rclient.smembersAsync(ARCHIVED_SET_KEY);
    let removed = 0;
    for (const requestId of ids) {
      const exists = await rclient.existsAsync(requestKey(requestId));
      if (!exists) {
        await rclient.sremAsync(ARCHIVED_SET_KEY, requestId);
        removed++;
      }
    }
    if (removed > 0) {
      log.info('AccessRequestManager pruneArchivedSet removed', removed, 'stale ids from archived set');
    }
  }

  /**
   * Expire all pending access requests (run at midnight): set state to expired, set TTL 7 days, remove from pending and delete lookup.
   */
  async expirePendingRequests() {
    const ids = await rclient.smembersAsync(PENDING_SET_KEY);
    const now = Date.now() / 1000;
    for (const requestId of ids) {
      const raw = await rclient.getAsync(requestKey(requestId));
      if (!raw) {
        await rclient.sremAsync(PENDING_SET_KEY, requestId);
        continue;
      }
      try {
        const req = JSON.parse(raw);
        if (req.state !== STATE_PENDING) {
          await rclient.sremAsync(PENDING_SET_KEY, requestId);
          await rclient.delAsync(currentLookupKey(req.userId, req.app));
          continue;
        }
        req.state = STATE_EXPIRED;
        req.updatedAt = now;
        await rclient.setAsync(requestKey(requestId), JSON.stringify(req));
        await rclient.expireAsync(requestKey(requestId), ARCHIVE_TTL_SECONDS);
        await rclient.sremAsync(PENDING_SET_KEY, requestId);
        await rclient.saddAsync(ARCHIVED_SET_KEY, requestId);
        await rclient.delAsync(currentLookupKey(req.userId, req.app));
      } catch (e) {
        log.error('AccessRequestManager expirePendingRequests error', requestId, e.message);
      }
    }
  }

  _getEndOfDayTimestamp(tz) {
    const tzName = tz || 'UTC';
    if (moment.tz.zone(tzName)) {
      return moment().tz(tzName).endOf('day').unix();
    }
    return moment().utc().endOf('day').unix();
  }
}

let instance = null;
function getInstance() {
  if (!instance) instance = new AccessRequestManager();
  return instance;
}

let expireCronJob = null;
function scheduleExpireCronJob() {
  if (expireCronJob) return;
  const CronJob = require('cron').CronJob;
  const sysManager = require('../net2/SysManager.js');
  const tz = sysManager.getTimezone();
  expireCronJob = new CronJob('0 0 * * *', async () => {
    log.info('Running access request expire job (midnight)');
    const manager = getInstance();
    await manager.expirePendingRequests().catch(e => log.error('Access request expire job error:', e.message));
    await manager.pruneArchivedSet().catch(e => log.error('Access request prune archived set error:', e.message));
  }, null, true, tz);
}

module.exports = {
  getInstance,
  scheduleExpireCronJob,
  findMatchingTimeLimitRules,
  getUserRelatedTags,
  AccessRequestManager,
  STATE_PENDING,
  STATE_APPROVED,
  STATE_DENIED,
  STATE_EXPIRED,
  PENDING_SET_KEY,
  ARCHIVED_SET_KEY,
  requestKey,
  currentLookupKey
};
