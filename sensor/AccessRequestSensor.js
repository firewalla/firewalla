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
const AccessRequestManager = require('../alarm/AccessRequestManager.js');

class AccessRequestSensor extends Sensor {
  apiRun() {
    extensionManager.onCmd('approveAccessRequest', async (msg, data) => {
      const requestId = data && data.requestId;
      if (!requestId) {
        throw { code: 400, msg: 'requestId is required' };
      }
      const approvedQuota = data && data.approvedQuota != null ? data.approvedQuota : undefined;
      if (!approvedQuota || approvedQuota <= 0) {
        throw { code: 400, msg: 'approvedQuota must be greater than 0' };
      }
      const result = await AccessRequestManager.getInstance().approveRequest(requestId, approvedQuota);
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
      const result = await AccessRequestManager.getInstance().denyRequest(requestId, reason);
      if (!result.ok) {
        throw { code: 400, msg: result.error || 'Failed to deny' };
      }
      return result.request;
    });
  }
}

module.exports = AccessRequestSensor;
