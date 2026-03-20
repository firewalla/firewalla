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
const { getInstance: getAccessRequestManager, STATE_PENDING, STATE_APPROVED, STATE_DENIED, STATE_EXPIRED, getUserRelatedTags: getManagerUserRelatedTags, findMatchingTimeLimitRules} = require('../../alarm/AccessRequestManager.js');
const moment = require('moment-timezone/moment-timezone.js');
try { moment.tz.load(require('../../vendor_lib/moment-tz-data.json')); } catch (_) { /* optional */ }
const AppTimeUsageManager = require('../../alarm/AppTimeUsageManager.js');

const fs = require('fs');
const Mustache = require('mustache');
const path = require('path');
const CLOUD_VIEW_ASSETS_PATH = "/home/pi/.firewalla/run/assets/views";

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
  if (!clientIP || !sysManager.isLocalIP(clientIP)) {
    res.status(403).json({ error: 'Access allowed only from local network' });
    return;
  }
  let app = req.query.app;
  if (!app) {
    app = 'internet';
  }
  try {
    const monitorable = await hostManager.getIdentityOrHost(clientIP);
    if (!monitorable) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const userId = await getDeviceUserId(monitorable);
    const extraTimeLimitPolicy = await accessRequestManager.getExtraTimeLimitPolicy(userId);
    if (!extraTimeLimitPolicy || extraTimeLimitPolicy.mode === Constants.POLICY_EXTRA_TIME_LIMIT_MODE_OFF) {
      res.status(404).json({ error: 'Extra time limit is disabled for this user' });
      return;
    }

    const nowTs = Date.now() / 1000;
    const supportedAppsSet = new Set();
    // fetch all support time limit apps
    const supportedApps = await accessRequestManager.getSupportedApps();
    for (const supportedApp of supportedApps) {
      supportedAppsSet.add({app: supportedApp.app, displayName: supportedApp.displayName});
    }
    supportedAppsSet.add({app: 'internet', displayName: 'Internet'});

    // const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const appList = Array.from(supportedAppsSet).sort((a, b) => {
      if (a.app === 'internet') return -1;
      if (b.app === 'internet') return 1;
      return a.app.localeCompare(b.app);
    }).map(item => ({
      name: item.app,
      displayName: item.displayName,
      selected: item.app === app
    }));

    let appDisplayName = app;
    for (const entry of appList) {
      if (entry.name === app) {
        appDisplayName = entry.displayName;
        break;
      }
    }

    const matchedRules = await findMatchingTimeLimitRules(userId, app, { includeNonTimeLimitApps: true, includeDisabled: false });

    let bestRule = null;
    let bestSum = Infinity;
    for (const rule of matchedRules) {
      let quota = 0, extra = 0;
      const au = rule.appTimeUsage;
      if (au) { // this is a time limit rule
        quota = Number(rule.appTimeUsage.quota);
        if (au.extraQuota != null && au.extraQuotaUntilTs != null && nowTs < au.extraQuotaUntilTs) {
          extra = Number(au.extraQuota);
        }
      }
      const sum = quota + extra;
      if (sum < bestSum) {
        bestSum = sum;
        bestRule = rule;
      }
    }

    let quota = 0, extraQuota = 0, timeUsed = 0;
    if (bestRule) {
      const au = bestRule.appTimeUsage;
      if (au) {
        quota = Number(au.quota);
        if (au.extraQuota != null && au.extraQuotaUntilTs != null && nowTs < au.extraQuotaUntilTs) {
          extraQuota = Number(au.extraQuota);
        }
        timeUsed = Number(bestRule.appTimeUsed);
      } else {
        //TODO: get time used for blocked app, how to deal with paused rule and schedule rule?
        // timeUsed = await AppTimeUsageManager.getTimeUsage();
      }
    } else { //no rule found, no limit
      quota = -1;
      extraQuota = -1;
      //TODO: get time used for no limit app
      // timeUsed = await AppTimeUsageManager.getTimeUsage();
    }

    const tz = sysManager.getTimezone() || 'UTC';
    const startOfDay = moment.tz ? moment().tz(tz).startOf('day').unix() : moment().startOf('day').unix();
    const endOfDay = moment.tz ? moment().tz(tz).endOf('day').unix() : moment().endOf('day').unix();

    const pendingRequests = await accessRequestManager.listRequestsByUserIds(userId, {
      state: new Set([STATE_PENDING]), app: new Set([app])
    });
    const pendingRequest = pendingRequests.length > 0 ? pendingRequests[0] : null;

    const archivedRequests = await accessRequestManager.listRequestsByUserIds(userId, {
      state: new Set([STATE_APPROVED, STATE_DENIED]), app: new Set([app])
    });
    const todayArchived = archivedRequests
      .filter(r => r.requestTs != null && r.requestTs >= startOfDay && r.requestTs <= endOfDay)
      .sort((a, b) => (b.updatedAt || b.requestTs || 0) - (a.updatedAt || a.requestTs || 0));
    const latestResolved = todayArchived.length > 0 ? todayArchived[0] : null;

    const fmtQuota = (mins) => {
      if (mins >= 60 && mins % 60 === 0) {
        const h = mins / 60;
        return h + ' hour' + (h > 1 ? 's' : '');
      }
      return mins + ' minute' + (mins > 1 ? 's' : '');
    };

    let lastRequest = null;
    if (pendingRequest) {
      lastRequest = {
        isPending: true,
        time: moment.unix(pendingRequest.requestTs).tz(tz).format('h:mm'),
        quotaText: fmtQuota(Number(pendingRequest.requestQuota) || 0),
        requestId: pendingRequest.requestId || '',
        appDisplayName: appDisplayName
      };
    } else if (latestResolved) {
      lastRequest = {
        isApproved: latestResolved.state === STATE_APPROVED,
        isDenied: latestResolved.state === STATE_DENIED,
        time: moment.unix(latestResolved.updatedAt || latestResolved.requestTs).tz(tz).format('h:mm'),
        quotaText: fmtQuota(Number(latestResolved.requestQuota) || 0),
        approvedText: latestResolved.state === STATE_APPROVED
          ? fmtQuota(Number(latestResolved.approvedQuota) || 0) : '',
        requestId: latestResolved.requestId || '',
        appDisplayName: appDisplayName
      };
    }

    const data = {
      app,
      timeUsed,
      quota,
      extraQuota,
      appList,
      lastRequest
    };

    const accept = (req.headers && req.headers.accept) || '';
    if (accept.indexOf('text/html') !== -1) {
      const cloudPath = path.join(CLOUD_VIEW_ASSETS_PATH, 'time_limits.mustache');
      if (fs.existsSync(cloudPath)) {
        const template = fs.readFileSync(cloudPath, 'utf8');
        const rendered = Mustache.render(template, data);
        res.send(rendered);
        return;
      }
      res.render('time_limits', data);
    } else {
      res.json(data);
    }
  } catch (err) {
    log.error('App detail time limit route error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

router.post('/request-more', (req, res) => {
  const { app, appDisplayName } = req.body || {};
  if (!app) {
    res.status(400).json({ error: 'app is required' });
    return;
  }
  const data = { app, appDisplayName: appDisplayName || app };
  const requestMorePath = path.join(CLOUD_VIEW_ASSETS_PATH, 'request_more.mustache');
  if (fs.existsSync(requestMorePath)) {
    const template = fs.readFileSync(requestMorePath, 'utf8');
    const rendered = Mustache.render(template, data);
    res.send(rendered);
    return;
  }
  res.render('request_more', data);
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

    // get the extra time limit policy by userId
    const extraTimeLimitPolicy = await accessRequestManager.getExtraTimeLimitPolicy(userId);
    if (!extraTimeLimitPolicy || extraTimeLimitPolicy.mode === Constants.POLICY_EXTRA_TIME_LIMIT_MODE_OFF) {
      res.status(404).json({ error: 'Extra time limit is disabled for this user' });
      return;
    }

    const supportedApps = await accessRequestManager.getSupportedApps();
    if (!supportedApps.find(item => item.app === app) && app !== 'internet') {
      res.status(400).json({ error: `App: ${app} is not supported` });
      return;
    }

    const request = await accessRequestManager.createOrUpdateRequest(userId, app, reqQuota, {
      deviceMac: monitorable.getGUID ? monitorable.getGUID() : null,
      reason: reason || null
    });


    if (extraTimeLimitPolicy && extraTimeLimitPolicy.mode === Constants.POLICY_EXTRA_TIME_LIMIT_MODE_AUTO) {
      const autoApproveQuota = Number(extraTimeLimitPolicy.autoApproveLimit) || 0;
      // already approved quota
      let archivedRequests = await accessRequestManager.listRequestsByUserIds(userId, {
        state: new Set([STATE_APPROVED])
      });
      const tz = sysManager.getTimezone() || 'UTC';
      const startOfDay = moment.tz ? moment().tz(tz).startOf('day').unix() : moment().startOf('day').unix();
      const endOfDay = moment.tz ? moment().tz(tz).endOf('day').unix() : moment().endOf('day').unix();
      // only count today's requests
      archivedRequests = archivedRequests.filter(r => (r.requestTs != null && r.requestTs >= startOfDay && r.requestTs <= endOfDay));

      const approvedQuota = archivedRequests.reduce((acc, req) => acc + Number(req.approvedQuota) || 0, 0);
      const leftQuota = approvedQuota < autoApproveQuota ? autoApproveQuota - approvedQuota : 0;
      const actualApproveQuota = reqQuota <= leftQuota ? reqQuota : leftQuota;
      if (actualApproveQuota > 0) {
        // approve the request
        const result = await accessRequestManager.approveRequest(request.requestId, actualApproveQuota);
        if (!result.ok) {
          res.status(500).json({ error: 'Internal server error', message: result.error });
          return;
        }
      }
    }

    res.status(200).json(request);
  } catch (err) {
    log.error('Time limits request create error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

module.exports = router;
