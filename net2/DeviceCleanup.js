/*    Copyright 2026 Firewalla Inc.
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

// data kept for removed devices and identities, shared by host:delete, identity cleanup and
// device expiry. Each function takes a list, so one policy/alarm load or key scan serves a batch

const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const Constants = require('./Constants.js');

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();
const ExceptionManager = require('../alarm/ExceptionManager.js');
const em = new ExceptionManager();
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const am2 = new AlarmManager2();
const FlowAggrTool = require('./FlowAggrTool.js');
const flowAggrTool = new FlowAggrTool();
const FlowManager = require('./FlowManager.js');
const flowManager = new FlowManager();
const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();

// nothing retries once the device is gone, so a failed step must not skip the ones after it
async function step(what, guids, fn) {
  try {
    await fn();
  } catch (err) {
    log.error(`Failed to delete ${what} of`, guids, err);
  }
}

// rules, exceptions, alarms and flows of devices or identities
async function deleteRelatedData(guids) {
  await step('policies', guids, () => pm2.deleteMacRelatedPolicies(guids));
  await step('exceptions', guids, () => em.deleteMacRelatedExceptions(guids));
  await step('alarms', guids, () => am2.deleteMacRelatedAlarms(guids));
  await step('summed flows', guids, () => flowAggrTool.removeRecentSumFlows(guids));
  await step('flows', guids, () => flowManager.removeFlowsAll(guids));
}

async function deleteHostsRelatedData(macs) {
  await deleteRelatedData(macs);
  await step('lease records', macs, async () => {
    await dnsmasq.deleteLeaseRecord(macs);
    dnsmasq.scheduleRestartDHCPService();
  });

  await step('device indexes', macs, async () => {
    await rclient.zremAsync(Constants.REDIS_KEY_HOST_ACTIVE, macs);
    await rclient.sremAsync(Constants.REDIS_KEY_HOST_DHCPCONF, macs);
    await rclient.sremAsync(Constants.REDIS_KEY_HOST_PINNED, macs);
  });

  // TODO: delete and substract timeseries data from global/intf/tag

  // simply remove monitor spec directly here instead of adding reference to FlowMonitor.js
  await step('monitor specs', macs, () => rclient.unlinkAsync(macs.flatMap(mac => [
    "monitor:flow:" + mac,
    "monitor:large:" + mac,
  ])));
}

async function resetDap(macs) {
  const sl = f.isApi() ? require('../sensor/APISensorLoader.js') : require('../sensor/SensorLoader.js');
  const dapSensor = sl.getSensor('DapSensor');
  if (!dapSensor)
    return;
  for (const [i, mac] of macs.entries()) {
    const dapResult = await dapSensor.apiCall("POST", `/reset-dap/${mac}`);
    if (dapResult.code !== 200) {
      // dap is likely down, and each call can take its full timeout
      log.warn(`Failed to reset DAP for ${mac}, skipping ${macs.length - i - 1} more`, dapResult.msg || dapResult.code);
      return;
    }
  }
}

module.exports = {
  deleteRelatedData,
  deleteHostsRelatedData,
  resetDap,
};
