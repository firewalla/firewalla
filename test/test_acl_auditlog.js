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

const LRU = require('lru-cache');

const sysManager = require('../net2/SysManager.js');
const Policy = require('../alarm/Policy.js');
const conntrack = require('../net2/Conntrack.js');
const Constants = require('../net2/Constants.js');
const HostManager = require('../net2/HostManager');
const hostManager = new HostManager();

const ACLAuditLogPlugin = require('../sensor/ACLAuditLogPlugin.js');
const RuleStatsPlugin = require('../sensor/RuleStatsPlugin.js');

describe('Test process iptables log', function(){
  this.timeout(3000);

  before(() => {
    this.plugin = new ACLAuditLogPlugin({})
    sysManager.sysinfo = {};
    sysManager.sysinfo["eth0"] = {"name":"eth0","uuid":"1f97bb38-7592-4be0-8ea4-b53d353a2d01","mac_address":"20:6d:31:01:2b:43","ip_address":"192.168.203.134","subnet":"192.168.203.134/24","netmask":"255.255.255.0","gateway_ip":"192.168.203.1","gateway":"192.168.203.1","ip4_addresses":["192.168.203.134"],"ip4_subnets":["192.168.203.134/24"],"ip4_masks":["255.255.255.0"],"ip6_addresses":null,"ip6_subnets":null,"ip6_masks":null,"gateway6":"","dns":["192.168.203.1","8.8.8.8"],"resolver":null,"resolverFromWan":false,"conn_type":"Wired","type":"wan","rtid":11,"searchDomains":[],"localDomains":[],"rt4_subnets":null,"rt6_subnets":null,"ready":true,"active":true,"pendingTest":false,"origDns":["10.8.8.8"],"pds":null};
    sysManager.sysinfo["br0"] = {"name":"br0","uuid":"75da8a81-4881-4fcd-964f-7cb935355acc","mac_address":"20:6d:31:01:2b:40","ip_address":"192.168.196.1","subnet":"192.168.196.1/24","netmask":"255.255.255.0","gateway_ip":null,"gateway":null,"ip4_addresses":["192.168.196.1"],"ip4_subnets":["192.168.196.1/24"],"ip4_masks":["255.255.255.0"],"ip6_addresses":null,"ip6_subnets":null,"ip6_masks":null,"gateway6":null,"dns":null,"resolver":["192.168.203.1","8.8.8.8"],"resolverFromWan":true,"conn_type":"Wired","type":"lan","rtid":8,"searchDomains":["lan"],"localDomains":[],"rt4_subnets":null,"rt6_subnets":null,"origDns":null,"pds":null};
    sysManager.nicinfo = sysManager.sysinfo;
  });

  it('should process allow device rule', async() => {
    const line = "[82267.197189] [FW_ADT]A=A D=O CD=O IN=br0 OUT=eth0 PHYSIN=eth1 MAC=20:6d:31:01:2b:40:68:da:73:ac:11:07:08:00 SRC=192.168.196.105 DST=52.38.7.83 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=57226 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0 MARK=0x38";
    await this.plugin._processIptablesLog(line);
  });

  it('should process route rule', async() => {
    const line = "[423391.117685] [FW_ADT]A=R D=O CD=O M=57 IN=br0 OUT= PHYSIN=eth1 MAC=20:6d:31:01:2b:40:68:da:73:ac:11:07:08:00 SRC=192.168.196.105 DST=157.240.22.35 LEN=64 TOS=0x00 PREC=0x00 TTL=64 ID=0 DF PROTO=TCP SPT=58877 DPT=80 WINDOW=65535 RES=0x00 SYN URGP=0";
    await this.plugin._processIptablesLog(line);
  });

  it('should process disturb rule', async() => {
    const line = "Aug 29 17:02:20 localhost kernel: [364290.140849] [FW_ADT]A=D D=O CD=O IN=bond1 OUT=eth0 MAC=4e:a7:af:66:4c:33:6c:1f:f7:23:39:cb:08:00 SRC=192.168.216.136 DST=173.194.8.70 LEN=1492 TOS=0x00 PREC=0x00 TTL=127 ID=42722 DF PROTO=TCP SPT=55050 DPT=443 WINDOW=255 RES=0x00 ACK PSH URGP=0 MARK=0xc2040000";
    this.plugin.ruleStatsPlugin = new RuleStatsPlugin();
    this.plugin.ruleStatsPlugin.recordBuffer = [];
    await this.plugin.ruleStatsPlugin.globalOn();
    this.plugin.ruleStatsPlugin.cache = new LRU({max: 10, maxAge: 15 * 1000, updateAgeOnGet: false});
    this.plugin.ruleStatsPlugin.policyRulesMap = new Map();
    await this.plugin._processIptablesLog(line);
    await this.plugin.writeLogs();
    await this.plugin.ruleStatsPlugin.updateRuleStats();
  });

  it('should process global allow rule', async() => {
    this.plugin.ruleStatsPlugin = new RuleStatsPlugin();
    this.plugin.ruleStatsPlugin.cache = new LRU({max: 10, maxAge: 15 * 1000, updateAgeOnGet: false});
    const policy = new Policy({trust: true, protocol: "", disabled: 0, type: "dns", action:"allow", target:"www.chess.com", dnsmasq_only: false, direction: "outbound", pid: 88});
    this.plugin.ruleStatsPlugin.policyRulesMap = new Map();
    this.plugin.ruleStatsPlugin.policyRulesMap["allow"]= [policy];

    const line = "[FW_ADT]A=A D=O CD=O IN=br0 OUT=eth0 PHYSIN=eth1 MAC=20:6d:31:01:2b:40:68:da:73:ac:11:07:08:00 SRC=192.168.196.105 DST=216.239.38.120 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=TCP SPT=65061 DPT=443 WINDOW=65535 RES=0x00 SYN URGP=0";
    await this.plugin._processIptablesLog(line);

    await this.plugin._processIptablesLog(line);
  });

  it('should count an adblock-labeled hit as adblock when no rule covers the domain (issue #9261)', async () => {
    const origGetInterfaceViaIP = sysManager.getInterfaceViaIP;
    sysManager.getInterfaceViaIP = () => ({ uuid: 'test-intf-uuid-0001', ip_address: '0.0.0.0' });
    let adblockHitRecord = null;
    this.plugin.ruleStatsPlugin = { getMatchedPids: async () => [] };
    this.plugin.adblockPlugin = { recordAdblockHit: (r) => { adblockHitRecord = r; } };

    const record = { ac: 'block', reason: 'adblock', dn: 'adblock-only.example.com', sh: '192.168.196.105', mac: 'AA:BB:CC:DD:EE:01' };
    try {
      await this.plugin._processDnsRecord(record);
    } finally {
      sysManager.getInterfaceViaIP = origGetInterfaceViaIP;
    }

    expect(adblockHitRecord).to.not.be.null;
    expect(record.pid).to.be.undefined;
  });

  it('should count an adblock-labeled hit as the covering rule instead, not adblock (issue #9261)', async () => {
    const origGetInterfaceViaIP = sysManager.getInterfaceViaIP;
    sysManager.getInterfaceViaIP = () => ({ uuid: 'test-intf-uuid-0002', ip_address: '0.0.0.0' });
    let adblockHitRecord = null;
    this.plugin.ruleStatsPlugin = { getMatchedPids: async () => [42] };
    this.plugin.adblockPlugin = { recordAdblockHit: (r) => { adblockHitRecord = r; } };

    const record = { ac: 'block', reason: 'adblock', dn: 'adblock-and-rule.example.com', sh: '192.168.196.105', mac: 'AA:BB:CC:DD:EE:02' };
    try {
      await this.plugin._processDnsRecord(record);
    } finally {
      sysManager.getInterfaceViaIP = origGetInterfaceViaIP;
    }

    expect(adblockHitRecord).to.be.null;
    expect(record.pid).to.equal(42);
  });

  describe('local UDP block writes bpid', () => {
    let origSetConnEntry, origGetHostFast, setConnEntryCalls;

    beforeEach(() => {
      setConnEntryCalls = [];
      origSetConnEntry = conntrack.setConnEntry;
      conntrack.setConnEntry = async (...args) => { setConnEntryCalls.push(args); };
      origGetHostFast = hostManager.getHostFast;
      hostManager.getHostFast = () => ({ getUniqueId: () => 'BB:CC:DD:EE:FF:02' });
    });

    afterEach(() => {
      conntrack.setConnEntry = origSetConnEntry;
      hostManager.getHostFast = origGetHostFast;
    });

    it('local UDP block with MARK writes bpid with the rule pid, originator direction only', async () => {
      // D=L local flow, srcMac AA:BB:CC:DD:EE:01 is not one of the stubbed sysinfo MACs so it is not re-routed by isMyMac
      const line = "[FW_ADT]D=L CD=O IN=br0 OUT=br0 MAC=20:6d:31:01:2b:40:AA:BB:CC:DD:EE:01:08:00 SRC=192.168.196.105 DST=192.168.196.106 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=UDP SPT=55000 DPT=5555 WINDOW=65535 RES=0x00 URGP=0 MARK=0x2a";
      await this.plugin._processIptablesLog(line);

      const bpidCalls = setConnEntryCalls.filter(args => args[5] === Constants.REDIS_HKEY_CONN_BPID);
      expect(bpidCalls.length).to.equal(1);
      expect(bpidCalls[0]).to.deep.equal(['192.168.196.105', 55000, '192.168.196.106', 5555, 'udp', Constants.REDIS_HKEY_CONN_BPID, 42, 600]);
      // no reverse-direction write
      expect(setConnEntryCalls.some(args => args[0] === '192.168.196.106' && args[2] === '192.168.196.105')).to.equal(false);
    });

    it('local UDP block with no MARK (global ipset/security block) writes the 0 sentinel', async () => {
      const line = "[FW_ADT]D=L CD=O IN=br0 OUT=br0 MAC=20:6d:31:01:2b:40:AA:BB:CC:DD:EE:01:08:00 SRC=192.168.196.105 DST=192.168.196.106 LEN=64 TOS=0x00 PREC=0x00 TTL=63 ID=0 DF PROTO=UDP SPT=55000 DPT=5555 WINDOW=65535 RES=0x00 URGP=0";
      await this.plugin._processIptablesLog(line);

      const bpidCalls = setConnEntryCalls.filter(args => args[5] === Constants.REDIS_HKEY_CONN_BPID);
      expect(bpidCalls.length).to.equal(1);
      expect(bpidCalls[0]).to.deep.equal(['192.168.196.105', 55000, '192.168.196.106', 5555, 'udp', Constants.REDIS_HKEY_CONN_BPID, 0, 600]);
    });
  });

});
