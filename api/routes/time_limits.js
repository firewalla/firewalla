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
const { getInstance: getAccessRequestManager, STATE_PENDING, STATE_APPROVED, STATE_DENIED, STATE_EXPIRED, getUserRelatedTags: getManagerUserRelatedTags, findMatchingTimeLimitRules, getAppFromTarget} = require('../../alarm/AccessRequestManager.js');
const moment = require('moment-timezone/moment-timezone.js');
try { moment.tz.load(require('../../vendor_lib/moment-tz-data.json')); } catch (_) { /* optional */ }

const TagManager = require('../../net2/TagManager.js');
const firewalla = require('../../net2/Firewalla.js');

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
  let mac = null;
  if (req.body && req.body.mac) {
    mac = req.body.mac;
  }
  let target = getClientIP(req);

  if (mac) {
    if (firewalla.isDevelopmentVersion()) {
      target = mac;
    } else {
      if (!target || !sysManager.isLocalIP(target)) {
        return { monitorable: null, userId: null };
      }
    }
  }

  const monitorable = await hostManager.getIdentityOrHost(target);
  if (!monitorable) {
    return { monitorable: null, userId: null };
  }
  const userId = await getDeviceUserId(monitorable);
  return { monitorable, userId };
}

router.get('/', async (req, res) => {
  let target = getClientIP(req);

  if (req.query && req.query.mac) { 
    if (firewalla.isDevelopmentVersion()) {
      target = req.query.mac;
    } else {
      if (!target || !sysManager.isLocalIP(target)) {
        res.status(403).json({ error: 'Access allowed only from local network' });
        return;
      }
    }
  }

  try {
    const monitorable = await hostManager.getIdentityOrHost(target);
    if (!monitorable) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const userId = await getDeviceUserId(monitorable);
    if (!userId) {
      res.status(404).json({ error: 'No user tag found for this device' });
      return;
    }
    const extraTimeLimitPolicy = await accessRequestManager.getExtraTimeLimitPolicy(userId);
    if (!extraTimeLimitPolicy || extraTimeLimitPolicy.mode === Constants.POLICY_EXTRA_TIME_LIMIT_MODE_OFF) {
      res.status(404).json({ error: 'Extra time limit is disabled for this user' });
      return;
    }

    const userTag = TagManager.getTagByUid(userId);
    const userInfo = {
      id: userId,
      name: userTag ? userTag.getTagName() : null,
      extraTimeLimitPolicy: extraTimeLimitPolicy,
      icon: null,
    };

    const nowTs = Date.now() / 1000;
    const appSpecs = {};
    // fetch all support time limit apps
    const supportedApps = await accessRequestManager.getSupportedApps();
    const appIcons = await accessRequestManager.getAllAppIcons();
    for (const supportedApp of supportedApps) {
      appSpecs[supportedApp.app] = {
        name: supportedApp.app,
        displayName: supportedApp.displayName,
        icon: appIcons[supportedApp.app] || null,
      };
    }
    appSpecs['internet'] = {
      name: 'internet',
      displayName: 'Internet',
      icon: "http://fire.walla:8833/time_limits/img/Internet_light@3x.png",
    };

    const matchedRules = await findMatchingTimeLimitRules(userId, "all", { includeNonTimeLimitRules: true, includeDisabled: false });

    const bestMatchAppMap = new Map();

    for (const rule of matchedRules) {
      const appQuotaInfo = {
        bestMatchPolicy: null,
        app: null,
        apps: [],
        quota: 0,
        extraQuota: 0,
        timeUsed: 0,
        pendingRequest: null,
        latestResolved: null,
      };

      if (rule.appTimeUsage) {
        appQuotaInfo.quota = Number(rule.appTimeUsage.quota);
        if (rule.appTimeUsage.extraQuota != null && rule.appTimeUsage.extraQuotaUntilTs != null && nowTs < rule.appTimeUsage.extraQuotaUntilTs) {
          appQuotaInfo.extraQuota = Number(rule.appTimeUsage.extraQuota);
        }
        appQuotaInfo.timeUsed = Number(rule.appTimeUsed);
      }

      if (rule.targets && rule.targets.length > 1) {
        appQuotaInfo.bestMatchPolicy = rule.pid;
        appQuotaInfo.app = `policy:${rule.pid}`;

        for (const target of rule.targets) {
          const targetApp = getAppFromTarget(target);
          appQuotaInfo.apps.push(targetApp);
        }
        bestMatchAppMap.set(appQuotaInfo.app, appQuotaInfo);
      } else {
        appQuotaInfo.bestMatchPolicy = rule.pid;
        appQuotaInfo.app = getAppFromTarget(rule.target);
        //get app from targets
        if (!appQuotaInfo.app && rule.targets && rule.targets.length == 1) {
          appQuotaInfo.app = getAppFromTarget(rule.targets[0]);
        }
        appQuotaInfo.apps.push(appQuotaInfo.app);
        if (!bestMatchAppMap.has(appQuotaInfo.app)) {
          bestMatchAppMap.set(appQuotaInfo.app, appQuotaInfo);
        } else {
          const bestMatchApp = bestMatchAppMap.get(appQuotaInfo.app);
          if (bestMatchApp.quota + bestMatchApp.extraQuota > appQuotaInfo.quota + appQuotaInfo.extraQuota) {
            bestMatchAppMap.set(appQuotaInfo.app, appQuotaInfo);
          }
        }
      }
    }

    const extraTimeRequests = await accessRequestManager.listRequestsByUserIds(userId,{ todayOnly: true });
    const resolvedRequests = extraTimeRequests.filter(r => r.state == STATE_APPROVED || r.state == STATE_DENIED);

    for (const [app, appQuotaInfo] of bestMatchAppMap.entries()) {
      const appPendingRequests = extraTimeRequests.filter(r => r.app === app && r.state === STATE_PENDING);
      const appResolvedRequests = extraTimeRequests.filter(r => r.app === app && (r.state == STATE_APPROVED || r.state == STATE_DENIED));
      appQuotaInfo.pendingRequest = appPendingRequests.length > 0 ? appPendingRequests[0] : null;
      for (const appResolvedRequest of appResolvedRequests) {
        if (!appQuotaInfo.latestResolved || appResolvedRequest.updatedAt > appQuotaInfo.latestResolved.updatedAt) {
          appQuotaInfo.latestResolved = appResolvedRequest;
        }
      }
    }


    const data = {
      user: userInfo,
      appSpecs: appSpecs,
      appQuotas: Array.from(bestMatchAppMap.values()),
      resolvedRequests: resolvedRequests,
    };


    res.json(data);
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

    const matchingRules = await findMatchingTimeLimitRules(userId, app, { includeNonTimeLimitRules: true, includeDisabled: false });
    if (matchingRules.length === 0) {
      res.status(400).json({ error: `No time limit rule found for this user: ${userId} and app: ${app}` });
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
