/*    Copyright 2016-2024 Firewalla Inc.
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

'use strict'

let chai = require('chai');
let expect = chai.expect;

const APCMsgSensor = require('../sensor/APCMsgSensor.js');
const sysManager = require('../net2/SysManager.js');
const fireRouter = require('../net2/FireRouter.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const rclient = require('../util/redis_manager.js').getRedisClient();

/** Same fixture pattern as test_dap_analyze_device.js (createDapTestHost / DAP_TEST_*). */
const APC_TEST_HOST_MAC = 'AA:BB:CC:DD:EE:FF';
const APC_TEST_HOST_IP = '172.17.0.10';
/** Remote MAC for APC payload; not a real host — cleanup `audit:local:drop` for reverse record. */
const APC_TEST_PEER_MAC = 'AA:11:22:33:44:55';

function ensureAclAuditLogPluginRuleStatsForTest(plugin) {
  if (plugin.ruleStatsPlugin) {
    return;
  }
  plugin.ruleStatsPlugin = {
    accountRule() {},
    getMatchedPids: async () => [],
    getPolicyIds: async () => []
  };
}

async function flushApcAuditBuffer(apcSensor) {
  const deadline = Date.now() + 5000;
  while (!apcSensor.aclAuditLogPlugin && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const plugin = apcSensor.aclAuditLogPlugin;
  if (plugin) {
    ensureAclAuditLogPluginRuleStatsForTest(plugin);
    await plugin.writeLogs();
  }
}

async function createApcTestHost() {
  const tsStr = new Date() / 1000 + '';
  await hostTool.updateIPv4Host({
    ipv4Addr: APC_TEST_HOST_IP,
    mac: APC_TEST_HOST_MAC,
    uid: APC_TEST_HOST_IP,
    lastActiveTimestamp: tsStr,
    firstFoundTimestamp: tsStr,
    hostname: 'APC Test Device',
    hostnameType: 'PTR',
    macVendor: 'Apple'
  });
  await hostTool.updateMACKey({
    bname: 'APC Test Device',
    host: 'APC Test Device',
    uid: APC_TEST_HOST_IP,
    lastActiveTimestamp: tsStr,
    firstFoundTimestamp: tsStr,
    pname: 'UnknownMobile/iOS',
    mac: APC_TEST_HOST_MAC,
    _name: 'iPhone',
    ipv4Addr: APC_TEST_HOST_IP,
    macVendor: 'Apple',
    deviceClass: 'mobile',
    ua_os_name: 'iOS',
    ipv4: APC_TEST_HOST_IP,
    ipv6Addr: '["fe80::aa07:d334:59a3:1200"]'
  });
}

async function removeApcTestHost() {
  await Promise.all([
    hostTool.deleteHost(APC_TEST_HOST_IP),
    hostTool.deleteMac(APC_TEST_HOST_MAC)
  ]);
}

async function removeApcTestAuditKeys() {
  await rclient.delAsync(
    `audit:local:drop:${APC_TEST_HOST_MAC}`,
    `audit:local:drop:${APC_TEST_PEER_MAC}`
  );
}

describe('Test apc block message', function(){
  this.timeout(30000);

  before(async() => {
    this.plugin = new APCMsgSensor({});

    sysManager.iptablesReady = true;
    await fireRouter.init();
    await sysManager.updateAsync();
  });

  after((done) => {
    done();
  });

  it('should process apc block message', async() => {
    // policy
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "src":"192.168.1.100","dst":"192.168.1.200", "pid":9, "action":"block",
        "sport":12345,"dport":54321, "smac":"00:11:22:33:44:55", "proto": "udp",
        "dmac":"00:22:44:66:88:11","ct":3,"ts":Date.now()/1000}));

    // group isolate
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "action":"block","pid":0,"src":"192.168.242.124","dst":"192.168.242.79",
        "sport":5353,"dport":5353,"smac":"30:D5:3E:CF:F8:76","dmac":"CC:08:FA:61:CC:8B","ct":1,
        "ts":Date.now()/1000,"proto":"udp","iso_lvl":3,"gid":820,"iso_ext":true,"iso_int":true}));

    // device isolate
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "action":"block","pid":2415919104,"src":"192.168.77.124","dst":"192.168.77.189","sport":50261,
        "dport":80,"smac":"30:D5:3E:CF:F8:76","dmac":"88:E9:FE:86:FF:94",
        "ct":1,"ts":Date.now()/1000,"proto":"tcp","iso_lvl":1}));

    // ssid isolate
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "action":"block","pid":2684354560,"src":"192.168.242.124","dst":"192.168.242.79","sport":50909,
        "dport":59585,"smac":"30:D5:3E:CF:F8:76","dmac":"CC:08:FA:61:CC:8B",
        "ct":1,"ts":Date.now()/1000,"proto":"tcp","iso_lvl":2}
    ));
  });


  it('should record apc block message with isoGID to redis correctly', async() => {
    await createApcTestHost();
    try {
      await removeApcTestAuditKeys();
      this.plugin.processApcBlockFlowMessage(JSON.stringify({
        action: 'block',
        pid: 2415919104,
        src: APC_TEST_HOST_IP,
        dst: '203.0.113.50',
        sport: 50261,
        dport: 80,
        smac: APC_TEST_HOST_MAC,
        dmac: APC_TEST_PEER_MAC,
        ct: 1,
        ts: (Date.now() - 1000)/1000,
        proto: 'tcp',
        iso_lvl: 1,
        gid: 99
      }));

      await flushApcAuditBuffer(this.plugin);
      const key = `audit:local:drop:${APC_TEST_HOST_MAC}`;
      const members = await rclient.zrangeAsync(key, 0, -1);
      expect(members.length).to.be.at.least(1);
      const withIso = members.map((s) => JSON.parse(s)).find((r) => r.isoGID != null);
      expect(withIso, 'expected a stored record with isoGID').to.exist;
      expect(withIso.isoGID).to.be.a('string');
      expect(withIso.isoGID).to.equal('99');
    } finally {
      await removeApcTestAuditKeys();
      await removeApcTestHost();
    }
  });

});
