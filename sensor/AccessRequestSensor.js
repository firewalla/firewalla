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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const extensionManager = require('./ExtensionManager.js');
const { getInstance: getAccessRequestManager, getUserRelatedTags, getAppsFromPolicy } = require('../alarm/AccessRequestManager.js');
const LOCK_BYPASS_RULE_UPDATE = "LOCK_BYPASS_RULE_UPDATE";
const _ = require('lodash');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const sem = require('./SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();
const Policy = require('../alarm/Policy.js');
const Constants = require('../net2/Constants.js');

class AccessRequestSensor extends Sensor {
  constructor(config) {
    super(config);
    this.tagManager = require('../net2/TagManager.js');;
  }

  apiRun() {
    extensionManager.onCmd('approveAccessRequest', async (msg, data) => {
      const requestId = data && data.requestId;
      if (!requestId) {
        throw { code: 400, msg: 'requestId is required' };
      }
      let approvedQuota = data && data.approvedQuota != null ? data.approvedQuota : undefined;
      if (approvedQuota != null) {
        const num = Number(approvedQuota);
        if (Number.isNaN(num)) {
          throw { code: 400, msg: 'approvedQuota must be a number' };
        }
        if (num <= 0 || num >= 86400) {
          throw { code: 400, msg: 'approvedQuota must be greater than 0 and less than 86400' };
        }
        approvedQuota = num;
      }
      const result = await getAccessRequestManager().approveRequest(requestId, approvedQuota);
      if (!result.ok) {
        throw { code: 400, msg: result.error || 'Failed to approve' };
      }
      return result.request;
    });

    extensionManager.onCmd('denyAccessRequest', async (msg, data) => {
      const requestId = data && data.requestId;
      if (!requestId) {
        throw { code: 400, msg: 'requestId is required' };
      }
      const reason = data && data.reason;
      const result = await getAccessRequestManager().denyRequest(requestId, reason);
      if (!result.ok) {
        throw { code: 400, msg: result.error || 'Failed to deny' };
      }
      return result.request;
    });

    extensionManager.onCmd('listExtraTimeRequests', async (msg, data) => {
      const options = data || {};
      const filterOpts = {};
      if (options.todayOnly) {
        filterOpts.todayOnly = true;
      }
      if (options.app) {
        filterOpts.app = new Set([options.app]);
      }
      if (options.userId) {
        filterOpts.userId = new Set([options.userId]);
      }
      const result = await getAccessRequestManager().listAllRequests(filterOpts);
      return result;
    });
  }
}

module.exports = AccessRequestSensor;
