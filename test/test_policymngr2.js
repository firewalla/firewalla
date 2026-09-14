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
const Bypass = require('../control/Bypass.js');
const Tag = require('../net2/Tag.js');

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

// The suite above stubs pm2.unenforce/enforceOnQueue, so it never reaches the real
// _unenforce()/_enforce()/_applyBypass() and can't see resolveRuleScope() or the guard it
// replaced. These tests call the real functions and stub only the outermost iptables/ipset
// seam (__applyRules / Bypass.bypassIptablesRules), matching test_bypass.js's convention of
// stubbing Tag.ensureCreateEnforcementEnv where a case still reaches it directly.
describe('Test _unenforce/_enforce/_applyBypass teardown when a rule\'s tag no longer exists', function() {
  this.timeout(5000);

  it('_unenforce() keeps a dead tag\'s uid in scope so teardown can still match enforcement', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeadTagOnly';
    const rule = new Policy({ pid: 'testDeadTagOnlyPid', type: 'intranet', action: 'block', tag: [`tag:${uid}`] });

    let applyRulesOptions = null;
    const origApplyRules = pm2.__applyRules;
    const origRemoveActivatedTime = pm2._removeActivatedTime;
    pm2.__applyRules = async (options) => { applyRulesOptions = options; };
    pm2._removeActivatedTime = async () => {};

    try {
      await pm2._unenforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._removeActivatedTime = origRemoveActivatedTime;
    }

    expect(applyRulesOptions).to.not.be.null;
    expect(applyRulesOptions.tags).to.deep.equal([uid]);
  });

  it('_unenforce() keeps a dead tag\'s uid in scope alongside an interface', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeadTagWithIntf';
    const intfUuid = 'testIntfUuid';
    const rule = new Policy({ pid: 'testDeadTagWithIntfPid', type: 'intranet', action: 'block', tag: [`tag:${uid}`, `intf:${intfUuid}`] });

    let applyRulesOptions = null;
    const origApplyRules = pm2.__applyRules;
    const origRemoveActivatedTime = pm2._removeActivatedTime;
    pm2.__applyRules = async (options) => { applyRulesOptions = options; };
    pm2._removeActivatedTime = async () => {};

    try {
      await pm2._unenforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._removeActivatedTime = origRemoveActivatedTime;
    }

    // before the fix, the guard couldn't fire here (an interface is present), but the
    // unconditional existence filter still silently dropped the dead tag from `tags`
    expect(applyRulesOptions).to.not.be.null;
    expect(applyRulesOptions.tags).to.deep.equal([uid]);
    expect(applyRulesOptions.intfs).to.deep.equal([intfUuid]);
  });

  it('_unenforce() keeps a dead tag alongside a live tag (the reenforce path)', async () => {
    const pm2 = new PolicyManager2();
    const deadUid = 'testDeadTagWithLive';
    const liveUid = 'testLiveTagWithDead';
    const rule = new Policy({ pid: 'testDeadTagWithLivePid', type: 'intranet', action: 'block', tag: [`tag:${deadUid}`, `tag:${liveUid}`] });

    let applyRulesOptions = null;
    const origApplyRules = pm2.__applyRules;
    const origRemoveActivatedTime = pm2._removeActivatedTime;
    pm2.__applyRules = async (options) => { applyRulesOptions = options; };
    pm2._removeActivatedTime = async () => {};

    try {
      await pm2._unenforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._removeActivatedTime = origRemoveActivatedTime;
    }

    // before the fix, deleteTagRelatedPolicies() routes this rule shape through 'reenforce',
    // which unenforces the old policy carrying both uids; the existence filter silently
    // dropped the dead one from `tags` even though the guard never fired
    expect(applyRulesOptions).to.not.be.null;
    expect(applyRulesOptions.tags).to.deep.equal([deadUid, liveUid]);
  });

  it('_unenforce() on the reported disturb/qos shape keeps the tag uid and the bypass chain name', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeadTagDisturb';
    const rule = new Policy({
      pid: 'testDeadTagDisturbPid', type: 'intranet', action: 'disturb', tag: [`tag:${uid}`],
      increaseLatency: 100, dropPacketRate: 10
    });

    let applyRulesOptions = null;
    const origApplyRules = pm2.__applyRules;
    const origRemoveActivatedTime = pm2._removeActivatedTime;
    pm2.__applyRules = async (options) => { applyRulesOptions = options; };
    pm2._removeActivatedTime = async () => {};

    try {
      await pm2._unenforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._removeActivatedTime = origRemoveActivatedTime;
    }

    // this is the exact options tuple that, before the fix, produced the leaked
    // FW_DISTURB_QOS_* jumps: a tag-scoped disturb rule rewritten to action 'qos'
    expect(applyRulesOptions).to.not.be.null;
    expect(applyRulesOptions.tags).to.deep.equal([uid]);
    expect(applyRulesOptions.byPassChain).to.equal(`FW_${rule.pid}_BYPASS`);
  });

  it('_unenforce() on a rule whose target is the deleted tag itself is unaffected by the guard', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeletedTagAsTarget';
    // deleteTagRelatedPolicies() reaches this shape via its rule.type === "tag" branch;
    // rule.tag is empty here so the guard (which checks `tag && tag.length`) never applied,
    // with or without the fix -- this just documents that this shape was never at risk
    const rule = new Policy({ pid: 'testDeletedTagAsTargetPid', type: 'tag', action: 'block', target: uid });

    let applyRulesOptions = null;
    const origApplyRules = pm2.__applyRules;
    const origRemoveActivatedTime = pm2._removeActivatedTime;
    const origTagEnsure = Tag.ensureCreateEnforcementEnv;
    pm2.__applyRules = async (options) => { applyRulesOptions = options; };
    pm2._removeActivatedTime = async () => {};
    Tag.ensureCreateEnforcementEnv = async () => {};

    try {
      await pm2._unenforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._removeActivatedTime = origRemoveActivatedTime;
      Tag.ensureCreateEnforcementEnv = origTagEnsure;
    }

    expect(applyRulesOptions).to.not.be.null;
    expect(applyRulesOptions.tags).to.deep.equal([]);
  });

  it('_enforce() drops a dead tag and stops before __applyRules', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeadTagEnforce';
    const rule = new Policy({ pid: 'testDeadTagEnforcePid', type: 'intranet', action: 'block', tag: [`tag:${uid}`] });

    let applyRulesCalled = false;
    const origApplyRules = pm2.__applyRules;
    const origRefreshActivatedTime = pm2._refreshActivatedTime;
    pm2.__applyRules = async () => { applyRulesCalled = true; };
    pm2._refreshActivatedTime = async () => {};

    try {
      await pm2._enforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._refreshActivatedTime = origRefreshActivatedTime;
    }

    // the enforce-side guard is unchanged: a tag that no longer exists must still be
    // dropped, or Block.setupTagsRules would create ipsets nothing will ever clean up
    expect(applyRulesCalled).to.be.false;
  });

  it('_unenforce() with a malformed (non-prefixed) tag field still stops before __applyRules', async () => {
    const pm2 = new PolicyManager2();
    const rule = new Policy({ pid: 'testMalformedTagPid', type: 'intranet', action: 'block', tag: ['garbage'] });

    let applyRulesCalled = false;
    const origApplyRules = pm2.__applyRules;
    const origRemoveActivatedTime = pm2._removeActivatedTime;
    pm2.__applyRules = async () => { applyRulesCalled = true; };
    pm2._removeActivatedTime = async () => {};

    try {
      await pm2._unenforce(rule);
    } finally {
      pm2.__applyRules = origApplyRules;
      pm2._removeActivatedTime = origRemoveActivatedTime;
    }

    // the format guard is untouched by the fix: a tag field that names nothing
    // recognizable still has nothing tag-scoped to tear down
    expect(applyRulesCalled).to.be.false;
  });

  it('_applyBypass(policy, "unenforce") keeps a dead tag\'s uid in scope', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeadTagBypassUnenforce';
    const bypassPolicy = new Policy({
      pid: 'testDeadTagBypassUnenforcePid', type: 'country', target: 'US',
      tag: [`tag:${uid}`], affectedPids: ['1']
    });

    let bypassOptions = null;
    const origBypassIptablesRules = Bypass.bypassIptablesRules;
    Bypass.bypassIptablesRules = async (options) => { bypassOptions = options; };

    try {
      await pm2._applyBypass(bypassPolicy, 'unenforce');
    } finally {
      Bypass.bypassIptablesRules = origBypassIptablesRules;
    }

    expect(bypassOptions).to.not.be.null;
    expect(bypassOptions.tags).to.deep.equal([uid]);
  });

  it('_applyBypass(policy, "enforce") drops a dead tag and stops before bypassIptablesRules', async () => {
    const pm2 = new PolicyManager2();
    const uid = 'testDeadTagBypassEnforce';
    const bypassPolicy = new Policy({
      pid: 'testDeadTagBypassEnforcePid', type: 'country', target: 'US',
      tag: [`tag:${uid}`], affectedPids: ['1']
    });

    let bypassCalled = false;
    const origBypassIptablesRules = Bypass.bypassIptablesRules;
    Bypass.bypassIptablesRules = async () => { bypassCalled = true; };

    try {
      await pm2._applyBypass(bypassPolicy, 'enforce');
    } finally {
      Bypass.bypassIptablesRules = origBypassIptablesRules;
    }

    expect(bypassCalled).to.be.false;
  });
});
