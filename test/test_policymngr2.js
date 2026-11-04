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

// _isBypassedFor() decides, per device, whether an active bypass rule cancels a rule. Two shapes
// reach it: an exclusion ("all devices except ..."), which carries no appTimeUsage, and an
// app-time-usage bypass, which only holds while quota is left. Reading appTimeUsage unguarded used
// to throw for the first shape, which took down the whole acl:check API.
describe('Test _isBypassedFor', function() {
  this.timeout(10000);

  const pm2 = new PolicyManager2();
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const OTHER_MAC = '11:22:33:44:55:66';
  const rule = { pid: '100' };

  const exclusion = (extra = {}) => Object.assign({ pid: '200', affectedPids: ['100'] }, extra);

  it('returns false when there is no bypass rule', async () => {
    expect(await pm2._isBypassedFor(rule, MAC, [])).to.equal(false);
    expect(await pm2._isBypassedFor(rule, MAC, undefined)).to.equal(false);
  });

  it('ignores a bypass rule that does not reference the rule', async () => {
    const other = exclusion({ affectedPids: ['999'], scope: [MAC] });
    expect(await pm2._isBypassedFor(rule, MAC, [other])).to.equal(false);
  });

  it('applies an exclusion that has no appTimeUsage', async () => {
    const b = exclusion({ scope: [MAC] });
    expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(true);
  });

  it('does not apply an exclusion scoped to another device', async () => {
    const b = exclusion({ scope: [OTHER_MAC] });
    expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(false);
  });

  it('applies a bypass rule that has no scope of its own to every device', async () => {
    const b = exclusion();
    expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(true);
    expect(await pm2._isBypassedFor(rule, OTHER_MAC, [b])).to.equal(true);
  });

  it('applies an app time usage bypass while quota is left', async () => {
    const b = exclusion({ scope: [MAC], appTimeUsage: { quota: 100 }, appTimeUsed: 30 });
    expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(true);
  });

  it('stops applying an app time usage bypass once quota is used up', async () => {
    const b = exclusion({ scope: [MAC], appTimeUsage: { quota: 100 }, appTimeUsed: 500 });
    expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(false);
  });

  it('counts extra quota only while it is still valid', async () => {
    const now = Date.now() / 1000;
    const live = exclusion({ scope: [MAC], appTimeUsage: { quota: 100, extraQuota: 500, extraQuotaUntilTs: now + 3600 }, appTimeUsed: 300 });
    const expired = exclusion({ scope: [MAC], appTimeUsage: { quota: 100, extraQuota: 500, extraQuotaUntilTs: now - 1 }, appTimeUsed: 300 });
    expect(await pm2._isBypassedFor(rule, MAC, [live])).to.equal(true);
    expect(await pm2._isBypassedFor(rule, MAC, [expired])).to.equal(false);
  });

  it('matches affectedPids that are stored as strings against a numeric pid', async () => {
    const b = exclusion({ scope: [MAC] });
    expect(await pm2._isBypassedFor({ pid: 100 }, MAC, [b])).to.equal(true);
  });

  // bypassIptablesRules() exempts each excluded object on its own, so the fields are an OR, not an
  // AND. Policy's constructor alone can produce a rule carrying two of them: a scope holding a MAC
  // and a VPN guid is split into scope + guids.
  it('covers both endpoints of a bypass rule that holds a MAC and a VPN guid', async () => {
    const GUID = 'vpn_profile:someClient';
    const b = exclusion({ scope: [MAC], guids: [GUID] });
    expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(true);
    expect(await pm2._isBypassedFor(rule, GUID, [b])).to.equal(true);
    expect(await pm2._isBypassedFor(rule, OTHER_MAC, [b])).to.equal(false);
  });

  it('covers a device that is only in the second group of a bypass rule', async () => {
    const orig = pm2.getDeviceByIdentity;
    pm2.getDeviceByIdentity = async () => ({ getTransitiveTags: async () => ({ group: { '6': 1 } }) });
    try {
      const b = exclusion({ tag: ['tag:5', 'tag:6'] });
      expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(true);
    } finally {
      pm2.getDeviceByIdentity = orig;
    }
  });

  // the firewall nests a group's device sets into the user tag it is assigned to, so a userTag
  // exclusion reaches the devices of that group
  it('covers a device that reaches the excluded user tag through its group', async () => {
    const orig = pm2.getDeviceByIdentity;
    pm2.getDeviceByIdentity = async () => ({
      getTags: async () => ['6'],                                   // direct: group 6 only
      getTransitiveTags: async () => ({ group: { '6': 1 }, user: { '7': 1 } }),
    });
    try {
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['userTag:7'] })])).to.equal(true);
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['userTag:8'] })])).to.equal(false);
    } finally {
      pm2.getDeviceByIdentity = orig;
    }
  });

  // bypassIptablesRules() exempts the tag's network set too, so a device with no tags of its own
  // sitting on a tagged network is covered
  it('covers a device whose network carries the excluded tag', async () => {
    const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
    const origDevice = pm2.getDeviceByIdentity;
    const origProfile = NetworkProfileManager.getNetworkProfile;
    pm2.getDeviceByIdentity = async () => ({
      getTransitiveTags: async () => ({}),            // the device itself has no tags
      getNicUUID: () => 'uuid-lan',
    });
    NetworkProfileManager.getNetworkProfile = uuid => uuid === 'uuid-lan'
      ? { getTags: async type => type === 'group' ? ['9'] : [] }
      : null;
    try {
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['tag:9'] })])).to.equal(true);
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['tag:10'] })])).to.equal(false);
    } finally {
      pm2.getDeviceByIdentity = origDevice;
      NetworkProfileManager.getNetworkProfile = origProfile;
    }
  });

  // Tag.tags() nests a child tag's device sets into its parent but not its network set, so a
  // network in a group that belongs to a user is NOT inside that user tag's network set. Claiming
  // the bypass here would hide a rule the firewall still enforces.
  it('does not follow the parents of the network own tags', async () => {
    const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
    const origDevice = pm2.getDeviceByIdentity;
    const origProfile = NetworkProfileManager.getNetworkProfile;
    pm2.getDeviceByIdentity = async () => ({
      getTransitiveTags: async () => ({}),            // untagged device
      getNicUUID: () => 'uuid-lan',
    });
    NetworkProfileManager.getNetworkProfile = () => ({
      // network is in group 6, and group 6 belongs to user 7
      getTags: async type => type === 'group' ? ['6'] : [],
      getTransitiveTags: async () => ({ group: { '6': 1 }, user: { '7': 1 } }),
    });
    try {
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['tag:6'] })])).to.equal(true);
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['userTag:7'] })])).to.equal(false);
    } finally {
      pm2.getDeviceByIdentity = origDevice;
      NetworkProfileManager.getNetworkProfile = origProfile;
    }
  });

  it('still matches on device tags when the network has none', async () => {
    const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
    const origDevice = pm2.getDeviceByIdentity;
    const origProfile = NetworkProfileManager.getNetworkProfile;
    pm2.getDeviceByIdentity = async () => ({
      getTransitiveTags: async () => ({ group: { '9': 1 } }),
      getNicUUID: () => 'uuid-lan',
    });
    NetworkProfileManager.getNetworkProfile = () => null;   // network not resolvable
    try {
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['tag:9'] })])).to.equal(true);
    } finally {
      pm2.getDeviceByIdentity = origDevice;
      NetworkProfileManager.getNetworkProfile = origProfile;
    }
  });

  it('does not bypass when the device cannot be resolved', async () => {
    const orig = pm2.getDeviceByIdentity;
    pm2.getDeviceByIdentity = async () => null;
    try {
      expect(await pm2._isBypassedFor(rule, MAC, [exclusion({ tag: ['tag:5'] })])).to.equal(false);
    } finally {
      pm2.getDeviceByIdentity = orig;
    }
  });

  it('ignores a scheduled bypass rule outside its time window', async () => {
    const scheduler = require('../extension/scheduler/scheduler.js');
    const orig = scheduler.shouldPolicyBeRunning;
    try {
      const b = exclusion({ scope: [MAC], cronTime: '0 9 * * *', duration: 3600 });
      scheduler.shouldPolicyBeRunning = () => 0;
      expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(false);
      scheduler.shouldPolicyBeRunning = () => 1800;
      expect(await pm2._isBypassedFor(rule, MAC, [b])).to.equal(true);
    } finally {
      scheduler.shouldPolicyBeRunning = orig;
    }
  });
});

// A disturb policy whose app has disableQuic derives a second, block-action policy that reuses the
// same pid and lands in the filter table's FW_<pid>_BYPASS chain. Whether that happens is read from
// the cloud disturb config, which loads asynchronously.
describe('Test disturb policy bypass plumbing', function() {
  this.timeout(10000);

  const PolicyDisturbManager = require('../alarm/PolicyDisturbManager.js');

  describe('checkIfNeedDisableQuic', () => {
    let origConf, origLoaded;

    beforeEach(() => {
      origConf = PolicyDisturbManager._appConfValue;
      origLoaded = PolicyDisturbManager.configLoaded;
    });

    afterEach(() => {
      PolicyDisturbManager._appConfValue = origConf;
      PolicyDisturbManager.configLoaded = origLoaded;
    });

    it('waits for the cloud config instead of deciding on an empty one', async () => {
      PolicyDisturbManager._appConfValue = {};
      PolicyDisturbManager.configLoaded = new Promise(resolve => setTimeout(() => {
        PolicyDisturbManager._appConfValue = { youtube: { disableQuic: true } };
        resolve();
      }, 50));
      expect(await PolicyDisturbManager.checkIfNeedDisableQuic({ pid: 1, target: 'TLX-dt-youtube' })).to.equal(true);
    });

    it('stays false for an app that does not disable quic', async () => {
      PolicyDisturbManager._appConfValue = { youtube: { disableQuic: true }, netflix: {} };
      PolicyDisturbManager.configLoaded = Promise.resolve();
      expect(await PolicyDisturbManager.checkIfNeedDisableQuic({ pid: 1, target: 'TLX-dt-netflix' })).to.equal(false);
    });
  });

});
