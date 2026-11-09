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
const TypeFlowTool = require('../flow/TypeFlowTool.js');
const categoryFlowTool = new TypeFlowTool('category');
const FlowAggrTool = require('./FlowAggrTool.js');
const flowAggrTool = new FlowAggrTool();
const FlowManager = require('./FlowManager.js');
const flowManager = new FlowManager();
const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();

// rules, exceptions, alarms and flows of devices or identities
async function deleteRelatedData(guids) {
  await pm2.deleteMacRelatedPolicies(guids);
  await em.deleteMacRelatedExceptions(guids);
  await am2.deleteMacRelatedAlarms(guids);
  await categoryFlowTool.delAllTypes(guids);
  await flowAggrTool.removeAggrFlowsAll(guids);
  await flowManager.removeFlowsAll(guids);
}

async function deleteHostsRelatedData(macs) {
  await deleteRelatedData(macs);
  await dnsmasq.deleteLeaseRecord(macs);
  dnsmasq.scheduleRestartDHCPService();

  await rclient.zremAsync(Constants.REDIS_KEY_HOST_ACTIVE, macs);
  await rclient.sremAsync(Constants.REDIS_KEY_HOST_DHCPCONF, macs);
  await rclient.sremAsync(Constants.REDIS_KEY_HOST_PINNED, macs);

  // TODO: delete and substract timeseries data from global/intf/tag

  // simply remove monitor spec directly here instead of adding reference to FlowMonitor.js
  await rclient.unlinkAsync(macs.flatMap(mac => [
    "monitor:flow:" + mac,
    "monitor:large:" + mac,
  ]));
}

async function resetDap(macs) {
  const sl = f.isApi() ? require('../sensor/APISensorLoader.js') : require('../sensor/SensorLoader.js');
  const dapSensor = sl.getSensor('DapSensor');
  if (!dapSensor)
    return;
  for (const mac of macs) {
    const dapResult = await dapSensor.apiCall("POST", `/reset-dap/${mac}`);
    if (dapResult.code !== 200) {
      log.warn(`Failed to reset DAP for ${mac}`, dapResult.msg || dapResult.code);
    }
  }
}

module.exports = {
  deleteRelatedData,
  deleteHostsRelatedData,
  resetDap,
};
