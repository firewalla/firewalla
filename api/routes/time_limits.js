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

const express = require('express');
const router = express.Router();
const _ = require('lodash');

const log = require('../../net2/logger.js')(__filename);
const HostManager = require('../../net2/HostManager.js');
const sysManager = require('../../net2/SysManager.js');
const Constants = require('../../net2/Constants.js');
const { getInstance: getAccessRequestManager, STATE_PENDING, STATE_APPROVED, STATE_DENIED, STATE_EXPIRED, getUserRelatedTags: getManagerUserRelatedTags, findMatchingTimeLimitRules } = require('../../alarm/AccessRequestManager.js');
const moment = require('moment-timezone/moment-timezone.js');
try { moment.tz.load(require('../../vendor_lib/moment-tz-data.json')); } catch (_) { /* optional */ }

const hostManager = new HostManager();
const accessRequestManager = getAccessRequestManager();

function getClientIP(req) {
  let ip = req.connection && req.connection.remoteAddress;
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
}

/**
 * Build rule tag values (prefix + uid) and names from AccessRequestManager.getUserRelatedTags result.
 * @param {string|null} userId - user tag uid
 * @returns {{ tagIds: string[], ruleValues: Set<string>, username: string }}
 */
function buildRuleValuesAndNames(userId) {
  const ruleValues = new Set();
  const tagIds = [];
  let username = '—';
  const { user, afTag } = getManagerUserRelatedTags(userId || '');
  const addTag = (tag) => {
    if (!tag || !tag.getTagType) return;
    const prefix = Constants.TAG_TYPE_MAP[tag.getTagType()] && Constants.TAG_TYPE_MAP[tag.getTagType()].ruleTagPrefix;
    const uid = tag.getUniqueId && tag.getUniqueId();
    if (prefix && uid != null) {
      ruleValues.add(prefix + uid);
      tagIds.push(String(uid));
    }
  };
  if (user) {
    username = (user.getTagName && user.getTagName()) || userId || '—';
    addTag(user);
  }
  if (afTag) addTag(afTag);
  return { tagIds, ruleValues, username };
}

/** Get at most one user-type tag uid for the monitorable. Uses getTransitiveTags and takes the 'user' tag from the result. */
async function getDeviceUserId(monitorable) {
  const transitiveTags = await monitorable.getTransitiveTags();
  const userTags = (transitiveTags && transitiveTags['user']) || {};
  const uids = Object.keys(userTags).map(String);
  return uids.length ? uids[0] : null;
}

/**
 * Get device user (monitorable and userId) from the source IP of the request.
 * @param {object} req - Express request
 * @returns {Promise<{ monitorable: object|null, userId: string|null }>}
 */
async function getDeviceUserFromRequest(req) {
  const clientIP = getClientIP(req);
  if (!clientIP || !sysManager.isLocalIP(clientIP)) {
    return { monitorable: null, userId: null };
  }
  const monitorable = await hostManager.getIdentityOrHost(clientIP);
  if (!monitorable) {
    return { monitorable: null, userId: null };
  }
  const userId = await getDeviceUserId(monitorable);
  return { monitorable, userId };
}

router.get('/', async (req, res) => {
  const clientIP = getClientIP(req);
  if (!clientIP) {
    res.status(400).json({ error: 'Could not determine client IP' });
    return;
  }
  if (!sysManager.isLocalIP(clientIP)) {
    res.status(403).json({ error: 'Access allowed only from local network' });
    return;
  }

  try {
    const monitorable = await hostManager.getIdentityOrHost(clientIP);
    if (!monitorable) {
      res.status(404).json({
        error: 'Device not found',
        message: 'No device found for your IP address.',
        device: null,
        appTimeLimits: [],
        pendingAccessRequests: [],
        previousAccessRequests: []
      });
      return;
    }

    const userId = await getDeviceUserId(monitorable);
    const pendingAccessRequests = await accessRequestManager.listRequestsByUserIds(userId, { state: new Set([STATE_PENDING]) });
    const archivedRequests = await accessRequestManager.listRequestsByUserIds(userId, {
      state: new Set([STATE_APPROVED, STATE_DENIED, STATE_EXPIRED])
    });
    const tz = sysManager.getTimezone() || 'UTC';
    const startOfDay = moment.tz ? moment().tz(tz).startOf('day').unix() : moment().startOf('day').unix();
    const endOfDay = moment.tz ? moment().tz(tz).endOf('day').unix() : moment().endOf('day').unix();
    const previousAccessRequests = archivedRequests.filter(r => (r.requestTs != null && r.requestTs >= startOfDay && r.requestTs <= endOfDay));

    const { tagIds, username } = buildRuleValuesAndNames(userId);

    const matchedRules = await findMatchingTimeLimitRules(userId);
    const nowTs = Date.now() / 1000;
    const appToBest = new Map();
    for (const rule of matchedRules) {
      const au = rule.appTimeUsage;
      if (!au) continue;
      // paused rule is also returned, but need to filter out in the result
      if (rule.disabled === '1') continue;
      const quota = Number(au.quota) || 0;
      const extraQuotaEffective = (au.extraQuota != null && au.extraQuotaUntilTs != null && nowTs < au.extraQuotaUntilTs)
        ? (Number(au.extraQuota) || 0) : 0;
      const sum = quota + extraQuotaEffective;
      let key;
      if (Array.isArray(au.apps) && au.apps.length > 0) {
        key = [...au.apps].sort().join(',');
      } else if (au.app) {
        key = String(au.app);
      } else {
        continue;
      }
      const existing = appToBest.get(key);
      if (!existing || sum < existing.sum) {
        appToBest.set(key, { app: key, quota, extraQuota: extraQuotaEffective, sum });
      }
    }
    const internetEntry = appToBest.get('internet');
    const internetTimeLimit = internetEntry ? { app: internetEntry.app, quota: internetEntry.quota, extraQuota: internetEntry.extraQuota } : null;
    const appTimeLimits = Array.from(appToBest.values())
      .filter(a => a.app !== 'internet')
      .map(({ app, quota, extraQuota }) => ({ app, quota, extraQuota }));

    const devicePayload = {
      mac: monitorable.getGUID(),
      ip: clientIP,
      name: monitorable.getReadableName()
    };

    const accept = (req.headers && req.headers.accept) || '';
    if (accept.indexOf('text/html') !== -1) {
      res.render('time_limits', {
        device: devicePayload,
        username,
        appTimeLimits,
        internetTimeLimit,
        pendingAccessRequests,
        previousAccessRequests
      });
    } else {
      res.json({
        device: devicePayload,
        tagIds,
        username,
        appTimeLimits,
        internetTimeLimit,
        pendingAccessRequests,
        previousAccessRequests
      });
    }
  } catch (err) {
    log.error('Time limits route error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

router.get('/request-more', (req, res) => {
  const app = req.query.app;
  if (!app) {
    res.status(400).json({ error: 'app query parameter is required' });
    return;
  }
  res.render('request_more', { app });
});

// ---------- Access requests (user: create, list mine; admin: list all, approve, deny) ----------

router.post('/requests', async (req, res) => {
  const { app, requestQuota, reason } = req.body || {};
  if (!app || requestQuota == null) {
    res.status(400).json({ error: 'app and requestQuota are required' });
    return;
  }
  const reqQuota = Number(requestQuota);
  if (Number.isNaN(reqQuota)) {
    res.status(400).json({ error: 'requestQuota must be a number' });
    return;
  }
  if (reqQuota <= 0 || reqQuota >= 86400) {
    res.status(400).json({ error: 'requestQuota must be greater than 0 and less than 86400' });
    return;
  }
  try {
    const { monitorable, userId } = await getDeviceUserFromRequest(req);
    if (!monitorable) {
      res.status(403).json({ error: 'Access allowed only from local network or device not found' });
      return;
    }
    if (!userId) {
      res.status(404).json({ error: 'No user tag found for this device' });
      return;
    }
    const request = await accessRequestManager.createOrUpdateRequest(userId, app, reqQuota, {
      deviceMac: monitorable.getGUID ? monitorable.getGUID() : null,
      reason: reason || null
    });
    res.status(200).json(request);
  } catch (err) {
    log.error('Time limits request create error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

module.exports = router;
