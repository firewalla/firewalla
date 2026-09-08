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

const PolicyManager2 = require('../alarm/PolicyManager2.js');
const Policy = require('../alarm/Policy.js');
const Alarm = require('../alarm/Alarm.js');

const domainBlock = require('../control/DomainBlock.js');
const cloudcache = require('../extension/cloudcache/cloudcache');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const { isDomainTargetValid } = require('../util/util.js');

const log = require('../net2/logger.js')(__filename);

describe('Test policy filter', function(){
    this.timeout(30000);
    let policyRules = [];

    before((done) => {
      const content = [
        {
          type: 'mac', action: 'block', direction: 'bidirection',
          timestamp: '1698162755.296', pid: '21', activatedTime: '1709174627.5555'
        },
        {
          type: 'intranet', action: 'block', direction: 'bidirection',
          timestamp: '1709176426.57', pid: '19', activatedTime: '1709174626.604'
        },
        {
          type: 'intranet', action: 'block', direction: 'outbound',
          timestamp: '1709144626.57', pid: '119', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'allow', direction: 'bidirection',
          timestamp: '1708675027.46', pid: '3220', upnp: 1
        },
        {
          type: 'mac', action: 'block', direction: 'outbound', 
          timestamp: '1709144610.61', pid: '29',
        },
        {
          type: 'country', action: 'allow', direction: 'inbound',
          timestamp: '1701206563.059', pid: '1772', activatedTime: '1701226566.891'
        },
        {
          type: 'intranet', action: 'allow', direction: 'bidirection',
          timestamp: '1700055205.116', pid: '139', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'qos', direction: 'bidirection',
          trafficDirection: 'upload', target: '20:6D:31:EF:FF:35',
          timestamp: '1646757685.122', activatedTime: '1646357685.296', pid: '1449'
        },
        {
          type: 'mac', action: 'allow', direction: 'inbound',
          timestamp: '1709174625.57', pid: '156', activatedTime: '1709174625.604'
        },
        {
          type: 'intranet', action: 'allow', direction: 'inbound',
          timestamp: '1709174626.57', pid: '159', activatedTime: '1709174626.604'
        },
        {
          type: 'dns', action: 'block', category: 'intel', direction: 'bidirection',
          timestamp: '1637111227.929', activatedTime: '1637229228.76', pid: '1484'
        },
        {
          type: 'intranet', action: 'allow', direction: 'outbound',
          timestamp: '1709164626.57', pid: '149', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'allow', direction: 'outbound',
          timestamp: '1709179626.57', pid: '1687', activatedTime: '1700011206.375'
        },
        {
          type: 'device', action: 'allow', direction: 'inbound',
          timestamp: '1699077479.42', pid: '1585', activatedTime: '1699077980.017'
        },
        {
          type: 'mac', action: 'block', direction: 'inbound',
          timestamp: '1709174626.57', pid: '22', activatedTime: '1709174627.5555'
        },
        {
          type: 'remotePort', direction: 'outbound', action: 'allow',
          timestamp: '1648018597.597', pid: '1436',
        },
        {
          type: 'country', action: 'route', routeType: 'hard', 'wanUUID': 'uuid', 
          timestamp: '1642562789.692', activatedTime: '1642562789.313', pid: '1457'
        },
        {
          type: 'mac', action: 'block', direction: 'inbound',
          timestamp: '1709221626.61', pid: '87', activatedTime: '1709221626.991'
        },
        {
          type: 'intranet', action: 'block', direction: 'inbound',
          timestamp: '1708210800.61', pid: '129', activatedTime: '1709174626.604'
        },
        {
          type: 'mac', action: 'allow', direction: 'inbound',
          timestamp: '1708675108.753', pid: '3212'
        },
        {
          type: 'ip', action: 'block', direction: 'bidirection',
          timestamp: '1628152313.054', pid: '1508',
          trust: false, target: '117.136.8.132', upnp: false, 
          target_name: '117.136.8.132', dnsmasq_only: false
        },
        {
          type: 'category', action: 'allow', direction: 'inbound',
          timestamp: '1701226563.123', pid: '1773', activatedTime: '1701226571.035'
        }
      ];
      policyRules = content.map(r => {
        return new Policy(r);
      });

      policyRules.sort((a, b) => {
        return b.timestamp - a.timestamp;
      })

      done();
    });
  
    after((done) => {
      done();
    });
  
    it('should split policy rules', async()=> {
      const pm2 = new PolicyManager2();
      const [routeRules, 
        inboundBlockInternetRules, inboundAllowInternetRules,
        inboundBlockIntranetRules, inboundAllowIntranetRules,
        internetRules, intranetRules, outboundAllowRules, otherRules] = pm2.splitRules(policyRules);
      
      expect(routeRules.length).to.equal(1);
      expect(inboundBlockInternetRules.map(r => {return r.pid;})).to.eql(['87', '22']);
      expect(inboundAllowInternetRules.map(r => {return r.pid;})).to.eql(['156', '3212']);
      expect(inboundBlockIntranetRules.map(r => {return r.pid;})).to.eql(['129']);
      expect(inboundAllowIntranetRules.map(r => {return r.pid;})).to.eql(['159']);
      expect(internetRules.map(r => {return r.pid;})).to.eql(['29', '21']);
      expect(intranetRules.map(r => {return r.pid;})).to.eql(['19', '119']);
      expect(outboundAllowRules.map(r => {return r.pid;})).to.eql(['1687', '149', '3220', '139']);
      expect(otherRules.length).to.equal(7);
    });


    it('should get high-impact rules', async() => {
      const pm2 = new PolicyManager2();
      const rules = await pm2.getHighImpactfulRules();
      expect(rules).to.not.be.null;
    })

});

describe('Test remotePort policy protocol match', function(){
  this.timeout(30000);

  function pornAlarm(protocol) {
    const alarm = new Alarm.PornAlarm(1648018597, 'OLIVER1', 'hentaijuggs.com', {
      'p.device.mac': '98:59:7A:48:46:08',
      'p.dest.name': 'hentaijuggs.com',
      'p.dest.port': '443',
    });
    if (protocol) alarm['p.protocol'] = protocol;
    return alarm;
  }

  it('should not match when protocol differs (udp rule vs tcp flow)', () => {
    const policy = new Policy({ type: 'remotePort', target: '443', protocol: 'udp', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.false;
  });

  it('should match when protocol is the same', () => {
    const policy = new Policy({ type: 'remotePort', target: '443', protocol: 'tcp', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.true;
  });

  it('should match regardless of protocol when rule omits protocol', () => {
    const policy = new Policy({ type: 'remotePort', target: '443', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.true;
  });

  it('should enforce protocol on remotePort used as an extra condition', () => {
    const policy = new Policy({ type: 'domain', target: 'hentaijuggs.com', remotePort: '443', protocol: 'udp', action: 'block' });
    expect(policy.match(pornAlarm('tcp'))).to.be.false;
  });
});

describe('Test priorityCompare', function(){
  // returns <0 if `this` outranks the arg, >0 if arg wins, 0 if equal

  const intranetScopedToDevice = new Policy({
    pid: '101', type: 'intranet', action: 'block', direction: 'bidirection',
    scope: ['20:6D:31:01:2B:43'],
  });
  const deviceTargetAllScope = new Policy({
    pid: '102', type: 'device', action: 'block', direction: 'bidirection',
    target: '20:6D:31:01:2B:43',
  });
  const intranetAllScope = new Policy({
    pid: '103', type: 'intranet', action: 'block', direction: 'bidirection',
  });

  it('treats device-scoped and device-target local rules as equal priority', () => {
    expect(intranetScopedToDevice.priorityCompare(deviceTargetAllScope)).to.equal(0);
    expect(deviceTargetAllScope.priorityCompare(intranetScopedToDevice)).to.equal(0);
  });

  it('ranks a device-specific local rule above an all-scope one', () => {
    expect(deviceTargetAllScope.priorityCompare(intranetAllScope)).to.be.below(0);
    expect(intranetAllScope.priorityCompare(deviceTargetAllScope)).to.be.above(0);
  });

  it('reads tag scope from the `tag` field (device group = level 2)', () => {
    const tagGroupRule = new Policy({
      pid: '104', type: 'intranet', action: 'block', tag: ['tag:8'],
    });
    expect(deviceTargetAllScope.priorityCompare(tagGroupRule)).to.be.below(0);
    expect(tagGroupRule.priorityCompare(intranetAllScope)).to.be.below(0);
  });

  it('lets seq band override specificity', () => {
    const highSeqAllScope = new Policy({
      pid: '105', type: 'intranet', action: 'block', seq: 1,
    });
    expect(highSeqAllScope.priorityCompare(deviceTargetAllScope)).to.be.below(0);
  });

  it('prefers allow over block at the same specificity', () => {
    const allowDevice = new Policy({ pid: '106', type: 'device', target: 'AA:BB:CC:DD:EE:FF', action: 'allow' });
    const blockDevice = new Policy({ pid: '107', type: 'device', target: 'AA:BB:CC:DD:EE:FF', action: 'block' });
    expect(allowDevice.priorityCompare(blockDevice)).to.equal(-1);
    expect(blockDevice.priorityCompare(allowDevice)).to.equal(1);
  });
});

describe('Test policy filter', function(){
  this.timeout(30000);

  it('should get category domains', async () => {
    const domains = await domainBlock.getCategoryDomains('adblock_strict', true);
    log.debug('getCategoryDomains adblock_strict', domains);
    log.debug('getCategoryDomains porn_bf', await domainBlock.getCategoryDomains('porn_bf', true))
    expect(domains).to.be.not.empty;
  });

  it('should get cloudcache', async() => {
    await cloudcache.enableCache('bf:app.porn_bf');
    let cacheItem = cloudcache.getCacheItem('bf:app.porn_bf');
    await cacheItem.download(false);
    log.debug('cloudcache content', cacheItem.localCachePath);
    const content = await cacheItem.getLocalCacheContent()
    expect(content).to.be.not.empty;
  });
});

describe('Test deleteTagRelatedPolicies unenforce synchronization', function() {
  this.timeout(5000);

  before(async () => {
    // enforceOnQueue() routes through this.queue, which is only wired up via setupPolicyQueue()
    // during normal FireMain startup (net2/main.js) -- initialize it here so the queue actually exists
    await new PolicyManager2().setupPolicyQueue();
  });

  it('should wait for the policy to actually unenforce before returning', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testTagUnenforce';
    const rule = new Policy({ pid: 'testUnenforcePid', type: 'intranet', action: 'block', tag: [`tag:${uid}`] });

    let unenforceCompleted = false;
    const origLoad = pm2.loadActivePoliciesAsync;
    const origUnenforce = pm2.unenforce;
    const origRemoveBypass = pm2.removeBypassChainForPolicy;
    pm2.loadActivePoliciesAsync = async () => [rule];
    pm2.unenforce = async () => {
      await new Promise(r => setTimeout(r, 50));
      unenforceCompleted = true;
    };
    pm2.removeBypassChainForPolicy = async () => {};

    try {
      await pm2.deleteTagRelatedPolicies(uid);
    } finally {
      pm2.loadActivePoliciesAsync = origLoad;
      pm2.unenforce = origUnenforce;
      pm2.removeBypassChainForPolicy = origRemoveBypass;
    }

    expect(unenforceCompleted).to.be.true;
  });

  // deleteTagRelatedPolicies() unenforces via enforceOnQueue() directly, bypassing enforce()/
  // setupPolicyQueue() -- the only two places that otherwise call removeBypassChainForPolicy() --
  // so it must call it explicitly or the rule's empty FW_<pid>_BYPASS chain lingers forever
  it('should remove the bypass chain for each rule it unenforces', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testTagBypassCleanup';
    const rule = new Policy({ pid: 'testBypassCleanupPid', type: 'intranet', action: 'block', tag: [`tag:${uid}`] });

    const removedBypassFor = [];
    const origLoad = pm2.loadActivePoliciesAsync;
    const origEnforceOnQueue = pm2.enforceOnQueue;
    const origRemoveBypass = pm2.removeBypassChainForPolicy;
    pm2.loadActivePoliciesAsync = async () => [rule];
    pm2.enforceOnQueue = async () => {};
    pm2.removeBypassChainForPolicy = async (policy) => { removedBypassFor.push(policy.pid); };

    try {
      await pm2.deleteTagRelatedPolicies(uid);
    } finally {
      pm2.loadActivePoliciesAsync = origLoad;
      pm2.enforceOnQueue = origEnforceOnQueue;
      pm2.removeBypassChainForPolicy = origRemoveBypass;
    }

    expect(removedBypassFor).to.deep.equal(['testBypassCleanupPid']);
  });

  it('should restore the old policy when replacement enforcement fails after old policy was unenforced', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testTagReenforceRollback';
    const rule = new Policy({ pid: 'testReenforcePid', type: 'intranet', action: 'block', tag: [`tag:${uid}`, 'otherTag'] });

    const unenforceCalls = [];
    const enforceCalls = [];
    const origLoad = pm2.loadActivePoliciesAsync;
    const origGetPolicy = pm2.getPolicy;
    const origUnenforce = pm2.unenforce;
    const origEnforce = pm2.enforce;
    pm2.loadActivePoliciesAsync = async () => [rule];
    pm2.getPolicy = async () => rule;
    pm2.unenforce = async (p) => { unenforceCalls.push(p.pid); };
    pm2.enforce = async (p) => {
      enforceCalls.push(p.tag ? [...p.tag] : null);
      if (enforceCalls.length === 1) throw new Error('simulated enforce failure');
    };

    try {
      await pm2.deleteTagRelatedPolicies(uid);
    } finally {
      pm2.loadActivePoliciesAsync = origLoad;
      pm2.getPolicy = origGetPolicy;
      pm2.unenforce = origUnenforce;
      pm2.enforce = origEnforce;
    }

    expect(unenforceCalls).to.deep.equal(['testReenforcePid']);
    // first call = failed attempt with the reduced tag list, second = rollback restoring the old (full) tag list
    expect(enforceCalls.length).to.equal(2);
    expect(enforceCalls[1]).to.deep.equal([`tag:${uid}`, 'otherTag']);
  });
});

describe('Test rule input validation', function() {
  this.timeout(5000);

  const fs = require('fs');
  const routing = require('../extension/routing/routing.js');

  it('should reject a line break in the policy target', () => {
    expect(() => new Policy({
      type: 'dns', action: 'block', target: 'example.com\naddress=/evil.com/1.2.3.4'
    })).to.throw(/Invalid control character/);
  });

  it('should reject a line break in the policy resolver', () => {
    expect(() => new Policy({
      type: 'dns', action: 'resolve', target: 'example.com', resolver: '1.2.3.4\nserver=/evil.com/8.8.8.8'
    })).to.throw(/Invalid control character/);
  });

  it('should keep accepting a plain domain target', () => {
    expect(new Policy({ type: 'dns', action: 'block', target: 'Example.com' }).target).to.equal('example.com');
  });

  it('should refuse to write a dnsmasq entry with a line break', async () => {
    const filePath = `/tmp/test_policy_entry_${process.pid}.conf`;
    let err = null;
    try {
      await dnsmasq.writeConfig(filePath, [
        'address=/example.com/0.0.0.0$policy_1',
        'address=/evil.com/1.2.3.4\nlog-queries'
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).to.not.be.null;
    expect(fs.existsSync(filePath)).to.be.false;

    await dnsmasq.writeConfig(filePath, ['address=/example.com/0.0.0.0$policy_1']);
    expect(fs.readFileSync(filePath, 'utf8')).to.equal('address=/example.com/0.0.0.0$policy_1\n');
    fs.unlinkSync(filePath);
  });

  it('should reject a routing table name that is not a plain name', async () => {
    for (const tableName of ['vc_$(id)', 'vc_x"; id #', 'vc_x\n']) {
      let err = null;
      try {
        await routing.createCustomizedRoutingTable(tableName);
      } catch (e) {
        err = e;
      }
      expect(err, `createCustomizedRoutingTable ${JSON.stringify(tableName)}`).to.not.be.null;

      err = null;
      try {
        await routing.removeCustomizedRoutingTable(tableName);
      } catch (e) {
        err = e;
      }
      expect(err, `removeCustomizedRoutingTable ${JSON.stringify(tableName)}`).to.not.be.null;
    }
  });
});

describe('Test policy field validation', function() {
  this.timeout(5000);

  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);

  // every field is checked, not just target and resolver
  const badFields = [
    { name: 'tag element',     raw: { type: 'dns', target: 'a.com', tag: ['tag:1', 'X' + NL + 'log-queries'] } },
    { name: 'nested app list', raw: { type: 'dns', target: 'a.com', appTimeUsage: { apps: ['ok', 'ba' + NL + 'd'] } } },
    { name: 'cronTime',        raw: { type: 'dns', target: 'a.com', cronTime: '0 0 * * *' + NL + 'x' } },
    { name: 'protocol',        raw: { type: 'dns', target: 'a.com', protocol: 'tcp' + NL + 'x' } },
    { name: 'a tab in target', raw: { type: 'dns', target: 'a.com' + TAB + 'x' } },
  ];

  for (const c of badFields) {
    it(`should reject a control character in the ${c.name}`, () => {
      expect(() => new Policy(c.raw)).to.throw(/Invalid control character/);
    });
  }

  it('should drop a scope element that is not a MAC before the field scan', () => {
    // scope is filtered to MAC addresses in the constructor, so a bad element never reaches a config
    const p = new Policy({
      type: 'mac', target: 'AA:BB:CC:DD:EE:FF', scope: ['AA:BB:CC:DD:EE:FF', 'X' + NL + 'log-queries']
    });
    expect(p.scope).to.deep.equal(['AA:BB:CC:DD:EE:FF']);
  });

  it('should allow a line break in notes, which is free text', () => {
    const p = new Policy({ type: 'dns', action: 'block', target: 'a.com', notes: 'line1' + NL + 'line2' });
    expect(p.notes).to.equal('line1' + NL + 'line2');
  });

  it('should still reject a non line break control character in notes', () => {
    expect(() => new Policy({
      type: 'dns', action: 'block', target: 'a.com', notes: 'a' + String.fromCharCode(0) + 'b'
    })).to.throw(/Invalid control character/);
  });

  // a value defining toJSON would be scanned in the form that method returns, not its real fields
  it('should reject a field that defines toJSON', () => {
    expect(() => new Policy({
      type: 'dns', action: 'block', target: 'a.com', appTimeUsage: { toJSON: () => ({ quota: 60 }) }
    })).to.throw(/Invalid control character/);
  });

  it('should keep accepting a rule with no odd characters anywhere', () => {
    const p = new Policy({
      type: 'dns', action: 'block', target: 'example.com', scope: ['AA:BB:CC:DD:EE:FF'],
      notes: 'blocked by admin', appTimeUsage: { apps: ['youtube'], quota: 60 }
    });
    expect(p.target).to.equal('example.com');
  });

  // the target becomes an iptables --tls-host argument, which is passed to a bash shell
  const domainTargets = [
    ['example.com', true],
    ['*.example.com', true],
    ['a-b_c.example.com', true],
    ['x$(id).com', false],
    ['a;id.com', false],
    ['a`id`.com', false],
    ['a b.com', false],
    ['*.', false],
  ];

  for (const [target, valid] of domainTargets) {
    it(`should report ${JSON.stringify(target)} as ${valid ? 'a valid' : 'an invalid'} domain target`, () => {
      expect(isDomainTargetValid(target)).to.equal(valid);
    });
  }

  it('should not build a TLS rule from a target that is not a domain', async () => {
    const pm2 = new PolicyManager2();
    const policy = new Policy({ pid: 'testTlsTarget', type: 'dns', action: 'block', target: 'x$(id).com' });

    let tlsHostSeen;
    const origRefresh = pm2._refreshActivatedTime;
    const origIsFirewalla = pm2.isFirewallaOrCloud;
    const origAddEntry = dnsmasq.addPolicyFilterEntry;
    const origApplyTls = pm2.__applyTlsRules;
    pm2._refreshActivatedTime = async () => {};
    pm2.isFirewallaOrCloud = () => false;
    dnsmasq.addPolicyFilterEntry = async () => {};
    pm2.__applyTlsRules = async (options) => { tlsHostSeen = options && options.tlsHost };

    try {
      await pm2._enforce(policy);
    } finally {
      pm2._refreshActivatedTime = origRefresh;
      pm2.isFirewallaOrCloud = origIsFirewalla;
      dnsmasq.addPolicyFilterEntry = origAddEntry;
      pm2.__applyTlsRules = origApplyTls;
    }

    expect(tlsHostSeen).to.be.undefined;
  });
});

describe('Test monitorable policy validation', function() {
  this.timeout(5000);

  const policyManager = require('../net2/PolicyManager.js');
  const NL = String.fromCharCode(10);

  function stubTarget(applied) {
    return {
      oper: {},
      constructor: { name: 'Host', getClassName: () => 'Host' },
      getReadableName: () => 'test host',
      getUniqueId: () => 'AA:BB:CC:DD:EE:FF',
      acl: async (v) => { applied.push(['acl', v]) },
      qos: async (v) => { applied.push(['qos', v]) },
      spoof: async (v) => { applied.push(['spoof', v]) },
      ipAllocation: async (v) => { applied.push(['ipAllocation', v]) },
    };
  }

  it('should skip only the policy that carries a control character', async () => {
    const applied = [];
    await policyManager.execute(stubTarget(applied), '1.2.3.4', {
      acl: 'bad' + NL + 'server-high=/evil.com/1.2.3.4',
      qos: false,
    });
    const keys = applied.map(a => a[0]);
    expect(keys).to.not.include('acl');
    expect(keys).to.include('qos');
  });

  it('should skip a policy whose value defines toJSON', async () => {
    const applied = [];
    await policyManager.execute(stubTarget(applied), '1.2.3.4', {
      acl: { toJSON: () => ({ state: true }) },
      qos: false,
    });
    const keys = applied.map(a => a[0]);
    expect(keys).to.not.include('acl');
    expect(keys).to.include('qos');
  });

  it('should apply a policy with no control character', async () => {
    const applied = [];
    await policyManager.execute(stubTarget(applied), '1.2.3.4', { acl: true, qos: false });
    const keys = applied.map(a => a[0]);
    expect(keys).to.include('acl');
    expect(keys).to.include('qos');
  });

  it('should drop a domain that is not a domain from domains_keep_local', async () => {
    let written = null;
    const orig = dnsmasq.writeConfig;
    dnsmasq.writeConfig = async (filePath, entries) => { written = entries };
    try {
      await dnsmasq.keepDomainsLocal('test_keep_local', {
        domains: ['example.com', 'evil.com/1.2.3.4' + NL + 'log-queries', 'ok.example.com'],
        blackhole: '1.2.3.4',
      });
    } finally {
      dnsmasq.writeConfig = orig;
    }
    expect(written).to.deep.equal([
      'server-high=/example.com/1.2.3.4',
      'server-high=/ok.example.com/1.2.3.4',
    ]);
  });

  it('should not write domains_keep_local at all when the blackhole is not an address', async () => {
    let called = false;
    const orig = dnsmasq.writeConfig;
    dnsmasq.writeConfig = async () => { called = true };
    try {
      await dnsmasq.keepDomainsLocal('test_keep_local', {
        domains: ['example.com'],
        blackhole: '1.2.3.4' + NL + 'log-queries',
      });
    } finally {
      dnsmasq.writeConfig = orig;
    }
    expect(called).to.be.false;
  });
});
