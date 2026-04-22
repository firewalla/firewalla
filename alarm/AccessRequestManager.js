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
const sysManager = require('../net2/SysManager.js');
const cronParser = require('cron-parser');
const Constants = require('../net2/Constants.js');
const _ = require('lodash');
const { rrWithErrHandling } = require('../util/requestWrapper.js');
const { include } = require('underscore');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const REQUEST_KEY_PREFIX = 'access_request:';
const CURRENT_LOOKUP_PREFIX = 'access_request:current:';
const PENDING_SET_KEY = 'access_request:pending';
const ARCHIVED_SET_KEY = 'access_request:archived';
const CURRENT_LOOKUP_SEP = '::'; // userId::app so colons in userId/app don't break parsing

const STATE_PENDING = 'pending';
const STATE_APPROVED = 'approved';
const STATE_DENIED = 'denied';
const STATE_EXPIRED = 'expired';

const TARGET_APP_PREFIXES = ['TLX-fw-', 'TLX-dt-']; // target values with these prefixes indicate app/category targets
const TARGET_PREFIX_LEN = 7; // length of the above prefixes

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

function isInSchedule(policy, includeNonTimeLimitRules = false) {
  // check if the policy is paused
  const now = Date.now() / 1000;
  if (policy.idleTs != null && policy.idleTs > 0) {
    
    if (now < policy.idleTs) {
      return false;
    }
  }

  // if the policy is expired, return false
  if (policy.expire) {
    if (policy.isExpired() || policy.willExpireSoon()) {
      return false;
    }
  }

  const au = policy.appTimeUsage;
  if (!au && !includeNonTimeLimitRules) {
    return false;
  }

  const cronTime = policy.cronTime;
  const duration = policy.duration;
  if (!cronTime || !duration) return true;

  // check if the policy is in schedule
  const interval = cronParser.parseExpression(cronTime, { tz: sysManager.getTimezone() });
  const lastTriggerTime = interval.prev().getTime() / 1000;
  const lastTriggerEndTime = lastTriggerTime + parseFloat(duration);

  if (lastTriggerTime <= now && now < lastTriggerEndTime) return true;
  return false;
}

function getAppFromTarget(target) {
  if (TARGET_APP_PREFIXES.some(prefix => target.startsWith(prefix))) {
    return target.substring(TARGET_PREFIX_LEN);
  }
  return null;
}

function getAppsFromPolicy(policy) {
  const appset = new Set();
  if (policy) {
    if (policy.type === "internet" || policy.type === "mac") {
      appset.add("internet");
    }
    if (policy.target && TARGET_APP_PREFIXES.some(prefix => policy.target.startsWith(prefix))) {
      appset.add(policy.target.substring(TARGET_PREFIX_LEN));
    }
    if (policy.targets && policy.targets.length > 0) {
      for (const target of policy.targets) {
        if (TARGET_APP_PREFIXES.some(prefix => target.startsWith(prefix))) {
          appset.add(target.substring(TARGET_PREFIX_LEN));
        }
      }
    }
  }
  return Array.from(appset).sort();
}

function matchTarget(policy, app, supportedApps = []) {
  // check if the policy targets and target are supported time limit apps
  if (policy.type == "internet" || policy.type == "mac") {
    if (app === 'internet' || app === 'all') {
      return true;
    } else {
      return false;
    }
  }


  if (supportedApps.length > 0) {
    if (policy.targets) {
      for (const target of policy.targets) {
        const targetApp = getAppFromTarget(target);
        if (!supportedApps.some(a => a.app === targetApp)) {
          return false;
        }
      }
    }
    if (policy.target) {
      const targetApp = getAppFromTarget(policy.target);
      if (!supportedApps.some(a => a.app === targetApp)) {
        return false;
      }
    }
  }

  if (app === 'all') {
    return true;
  }

  const apps = app.split(',').map(a => a.trim()).sort();
  if (apps.length > 1) { // match multi-target rules only when app is specified as multi-apps (comma separated), not when app is 'all'
    if (!policy.targets || policy.targets.length !== apps.length) {
      return false;
    }
    const policyApps = getAppsFromPolicy(policy);
    if (!apps.every(a => policyApps.includes(a))) {
      return false;
    }
  } else {
    if (policy.target) {
      const targetApp = getAppFromTarget(policy.target);
      if (targetApp != app) {
        return false;
      }
    }
  }
  return true;
}

// check if the policy is matched with the given app
function matchApp(policy, app='all', supportedApps = [], includeNonTimeLimitRules = false, includeNotInScheduleRules = false) {
  // check tag
  if (!policy.tag || policy.tag.length === 0 ) return false;

  // check target, target|targets should be supported apps and match the given app
  if (!matchTarget(policy, app, supportedApps)) return false;

  // check if the policy is in schedule
  if (!includeNotInScheduleRules && !isInSchedule(policy, includeNonTimeLimitRules)) return false;
  return true;
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
async function findMatchingTimeLimitRules(userId, app, options = {}) {
  const Constants = require('../net2/Constants.js');
  const PolicyManager2 = require('./PolicyManager2.js');
  const pm2 = new PolicyManager2();
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

  const policyTargetsUserOrGroup = (p) => p.tag && p.tag.some(t => ruleTagValues.has(t));
  const bypassPolicies = [];
  const blockOrDisturbPolicies = [];

  const accessRequestManager = getInstance();
  const supportedApps = await accessRequestManager.getSupportedApps();
  const apps = app.split(',').map(a => a.trim()).sort();
  for (const a of apps) {
    if (a !== 'all' && a !== 'internet' && !supportedApps.some(s => s.app === a)) {
      log.warn(`App ${a} is not supported for time limit rules, skip fetching policies for it`);
      return { bypassPolicies: bypassPolicies, blockOrDisturbPolicies: blockOrDisturbPolicies };
    }
  }

  const includeDisabled = options.includeDisabled ? 1 : 0;
  const allPolicies = await pm2.loadActivePoliciesAsync({ includingDisabled: includeDisabled });
  
  for (const policy of allPolicies) {
    if (policyTargetsUserOrGroup(policy) && matchApp(policy, app, supportedApps, options.includeNonTimeLimitRules, options.includeNotInScheduleRules)) {
      if (policy.action === 'bypass') {
        bypassPolicies.push(policy);
      } else if ( policy.action == 'app_block' || policy.action == 'block' || policy.action == 'disturb') {
        blockOrDisturbPolicies.push(policy);
      }
    }
  }
  return { bypassPolicies: bypassPolicies, blockOrDisturbPolicies: blockOrDisturbPolicies };
}


class AccessRequestManager {

  async getAllAppIcons() {
    const options = {
      uri: "https://s3-us-west-2.amazonaws.com/fireapp/fapp.json",
      family: 4,
      method: 'GET',

      maxAttempts: 3,
      json: true,
      retryDelay: 1000,
    };
    const appIcons = {};
    try {
      const response = await rrWithErrHandling(options, false, false, false);
      if (!response.body) return {};
      const body = response.body;
      
      for (const app of body.app) {
        appIcons[app.app] = app.icon;
      }
    } catch (err) {
      log.error("getAllAppIcons error", err.message);
      log.debug(err.stack)
      return {};
    }
    return appIcons;

  }

  async getSupportedApps() {
    const supportedApps = [];
    const appCloudConfig = await rclient.getAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);
    if (_.isObject(appCloudConfig) && !_.isEmpty(_.get(appCloudConfig, "appConfs"))) {
      for (const app of Object.keys(appCloudConfig.appConfs)) {
        const features = appCloudConfig.appConfs[app].features;
        if (!_.isEmpty(features) && features.timeUsage === true) {
          supportedApps.push({app: app, displayName: appCloudConfig.appConfs[app].displayName});
        }
      }
    }
    return supportedApps;
  }

  /**
   * Create or update an access request. If a pending request exists for (userId, app), reuse its id and overwrite.
   * @param {string} userId - user tag uid
   * @param {string} app - app/category key
   * @param {number} requestQuota - minutes requested
   * @param {number} leftQuota - minutes left
   * @param {object} options - { deviceMac, reason }
   * @returns {Promise<object>} request object with requestId
   */
  async createOrUpdateRequest(userId, app, requestQuota, leftQuota, options = {}) {
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
      leftQuota: Number(leftQuota) || 0,
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
      const req = JSON.parse(raw);
      if (!req.note || req.note == 'null') {
        delete req.note;
      }
      if (!req.mac || req.mac == 'null') {
        delete req.mac;
      }
      return req;
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

  async getExtraTimeLimitPolicy(userId) {
    const { user, afTag } = getUserRelatedTags(userId || '');
    if (!afTag) return null;
    return await afTag.getPolicyAsync('extraTimeLimit');
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

    const tz = sysManager.getTimezone() || 'UTC';
    const startOfDay = moment.tz ? moment().tz(tz).startOf('day').unix() : moment().startOf('day').unix();
    const endOfDay = moment.tz ? moment().tz(tz).endOf('day').unix() : moment().endOf('day').unix();
    for (const requestId of [...pendingIds, ...archivedIds]) {
      if (seen.has(requestId)) continue;
      seen.add(requestId);
      const req = await this.getRequest(requestId);
      if (!req) continue;
      if (stateSet && !stateSet.has(req.state)) continue;
      if (filter.userId && !filter.userId.has(req.userId)) continue;
      if (filter.app && !filter.app.has(req.app)) continue;
      if (filter.todayOnly && (req.requestTs < startOfDay || req.requestTs > endOfDay)) continue;
      list.push(req);
    }
    return list;
  }

  getBypassPolicyKey(userId, apps) {
    return `bypass:extraTime:${userId}:${apps.join(',')}`;
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
    const Policy = require('./Policy.js');

    const { blockOrDisturbPolicies } = await findMatchingTimeLimitRules(req.userId, req.app, { includeNonTimeLimitRules: true, includeDisabled: true, includeNotInScheduleRules: true });
    if (blockOrDisturbPolicies.length === 0) {
      return { ok: false, error: 'No time limit rule found for this user and app' };
    }

    const minutes = approvedQuota != null ? Number(approvedQuota) : Number(req.requestQuota) || 0;
    const tz = sysManager.getTimezone();
    const startOfTodayTs = this._getStartOfDayTimestamp(tz);
    const endOfTodayTs = this._getEndOfDayTimestamp(tz);
    const nowTs = Math.floor(Date.now() / 1000);
    const affectedPids = new Set();

    const totalQuotaLeft = req.leftQuota ? Number(req.leftQuota) + minutes : minutes;
    const calculateQuotaLeft = (policy) => {
      if (!policy.appTimeUsage) return 0;
      const au = policy.appTimeUsage;
      const ruleQuota = Number(au.quota) || 0;
      let ruleExtraQuota = 0;
      if (au.extraQuotaUntilTs != null && nowTs < au.extraQuotaUntilTs) {
        ruleExtraQuota = Number(au.extraQuota) || 0;
      }
      return ruleQuota + ruleExtraQuota - Number(policy.appTimeUsed);
    };

    // matchingPolices includes paused rules, but extraQuota on these rules can still be updated in case they are resumed after approval
    for (const policy of blockOrDisturbPolicies) {
      if (policy.appTimeUsage) {
        const oldPolicy = policy;
        const au = Object.assign({}, policy.appTimeUsage);
        const quotaLeft = calculateQuotaLeft(policy);

        if (quotaLeft >= totalQuotaLeft) {
          continue; // do nothing if the approved quota is already covered by the existing quota and extraQuota on the rule
        }

        au.extraQuota = Number(au.extraQuota) || 0;
        au.extraQuota += totalQuotaLeft - quotaLeft;

        au.extraQuotaUntilTs = endOfTodayTs;
        
        await pm2.updatePolicyAsync({ pid: policy.pid, appTimeUsage: au });
        const updatedPolicy = await pm2.getPolicy(policy.pid);
        if (updatedPolicy) {
          pm2.tryPolicyEnforcement(updatedPolicy, 'reenforce', oldPolicy);
        }
      }
      affectedPids.add(policy.pid);
      log.info(`Policy ${policy.pid} is affected by access request ${requestId} approval, will create bypass rule for it`);
    }

    // if there is any block rule affected, create/update the bypass rule
    let apps = req.app.split(',').map(a => a.trim()).sort();
    if (apps.length === 0) {
        log.warn('AccessRequestManager approveRequest no app found for affected block rules');
        return { ok: false, error: 'bad app format' };
    }

    const supportedApps = await this.getSupportedApps();
    for (const app of apps) {
      if (app !== 'internet' && !supportedApps.some(s => s.app === app)) {
        log.warn(`App ${app} is not supported for time limit rules, skip creating/updating bypass policy for it`);
        return { ok: false, error: `App ${app} is not supported for time limit rules` };
      }
    }

    if (affectedPids.size > 0) {
      const bypassPolicyKey = this.getBypassPolicyKey(req.userId, apps);
      const bypassPolicyId = await rclient.getAsync(bypassPolicyKey);
      const timeWindows = [{begin: startOfTodayTs * 1000, end: endOfTodayTs * 1000}];
      const AppTimeUsageManager = require('./AppTimeUsageManager.js');
      const appTimeUsed = await AppTimeUsageManager.getTimeUsage(`tag:${req.userId}`, apps, timeWindows, true);

      const au = {
        app: apps[0],
        apps: apps,
        quota: appTimeUsed + Number(req.leftQuota || 0), // set quota to current usage + leftQuota so that the approved quota can be fully covered
        extraQuota: minutes,
        extraQuotaUntilTs: endOfTodayTs,
        period: "0 0 * * *",
        onQuotaReached: "unenforce",
      };
      const policy = bypassPolicyId ? await pm2.getPolicy(Number(bypassPolicyId)) : null;

      if (policy) {
        const oldPolicy = policy;
        const newPolicy = new Policy(Object.assign({}, policy));
        if (!newPolicy.appTimeUsage || !newPolicy.appTimeUsage.extraQuota || !newPolicy.appTimeUsage.extraQuotaUntilTs 
          || newPolicy.appTimeUsage.extraQuotaUntilTs < nowTs) {
          newPolicy.appTimeUsage = au;
        } else {
          const quotaLeft = calculateQuotaLeft(policy);
          if (quotaLeft < totalQuotaLeft) {
            newPolicy.appTimeUsage.extraQuota = Number(newPolicy.appTimeUsage.extraQuota) + totalQuotaLeft - quotaLeft;
          }
          newPolicy.appTimeUsage.extraQuotaUntilTs = endOfTodayTs;
        }
        newPolicy.affectedPids = Array.from(affectedPids);
        newPolicy.expire = endOfTodayTs - nowTs;

        await pm2.updatePolicyAsync(newPolicy);
        const updatedPolicy = await pm2.getPolicy(policy.pid);
        if (updatedPolicy) {
          pm2.tryPolicyEnforcement(updatedPolicy, "reenforce", oldPolicy);
        }
      } else {
        //create a one-time bypass policy with reference to the original block policy, and enforce it immediately
        let type = "category";
        let target = `TLX-fw-${apps[0]}`;
        if (apps[0] === 'internet') {
          target = 'TAG';
          type = "mac";
        }
        // no need to add targets for disturb rules, since do not need to update dnsmasq config for distrub rules, 
        // for iptables rules, we can get the app name from the targets and use the app name to match rules
        const policyRaw = {
          action: "bypass",
          target: target,
          targets: apps.map(a => a === 'internet' ? 'TAG' : `TLX-fw-${a}`),
          affectedPids: Array.from(affectedPids),
          appTimeUsage: au,
          type: type,
          autoDeleteWhenExpires: "1",
          expire: endOfTodayTs - nowTs,
          timestamp: nowTs,
          tag: ["userTag:" + req.userId],
        };

        const oneTimePolicy = new Policy(policyRaw);
        const result = await pm2.checkAndSaveAsync(oneTimePolicy);

        await rclient.setAsync(bypassPolicyKey, result.policy.pid);
        await rclient.expireAsync(bypassPolicyKey, endOfTodayTs - nowTs + 60); // set bypass policy key to expire shortly after the policy expires

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
  _getStartOfDayTimestamp(tz) {
    const tzName = tz || 'UTC';
    if (moment.tz.zone(tzName)) {
      return moment().tz(tzName).startOf('day').unix();
    }
    return moment().utc().startOf('day').unix();
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
  matchApp,
  getAppFromTarget,
  getAppsFromPolicy,
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
