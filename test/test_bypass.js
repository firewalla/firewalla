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

const { expect } = require('chai');
const Constants = require('../net2/Constants.js');

// Pre-require lazy deps so patches are in module cache before Bypass uses them
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const iptc = require('../control/IptablesControl.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const Tag = require('../net2/Tag.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const Host = require('../net2/Host.js');
const IdentityManager = require('../net2/IdentityManager.js');

const Bypass = require('../control/Bypass.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePolicy(overrides = {}) {
  return Object.assign({
    type: 'category',
    action: 'block',
    target: 'social_media',
    seq: Constants.RULE_SEQ_REG,
    useBf: false,
  }, overrides);
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('Bypass', function () {
  this.timeout(5000);

  let addRuleCalls;
  let addFilterEntryCalls, removeFilterEntryCalls;
  let addCategoryFilterEntryCalls, removeCategoryFilterEntryCalls;
  let restartDNSCalled;
  const savedOriginals = {};
  let policyMap;

  before(() => {
    savedOriginals.addRule = iptc.addRule;

    savedOriginals.tagEnsure = Tag.ensureCreateEnforcementEnv;
    savedOriginals.tagDevSet = Tag.getTagDeviceSetName;
    savedOriginals.tagNetSet = Tag.getTagNetSetName;
    Tag.ensureCreateEnforcementEnv = async () => {};
    Tag.getTagDeviceSetName = uid => `fw_dev_tag_${uid}`;
    Tag.getTagNetSetName = uid => `fw_net_tag_${uid}`;

    savedOriginals.npEnsure = NetworkProfile.ensureCreateEnforcementEnv;
    savedOriginals.npNetList = NetworkProfile.getNetListIpsetName;
    NetworkProfile.ensureCreateEnforcementEnv = async () => {};
    NetworkProfile.getNetListIpsetName = uuid => `fw_net_${uuid}`;

    savedOriginals.hostEnsure = Host.ensureCreateEnforcementEnv;
    savedOriginals.hostDevSet = Host.getDeviceSetName;
    Host.ensureCreateEnforcementEnv = async () => {};
    Host.getDeviceSetName = mac => `fw_dev_${mac.replace(/:/g, '')}`;

    savedOriginals.idGetClass = IdentityManager.getIdentityClassByGUID;
    savedOriginals.idGetNS = IdentityManager.getNSAndUID;
    IdentityManager.getIdentityClassByGUID = () => ({
      ensureCreateEnforcementEnv: async () => {},
      getEnforcementIPsetName: (uid, fam) => `fw_id_${uid}_${fam}`,
    });
    IdentityManager.getNSAndUID = () => ({ ns: 'vpn', uid: 'test_uid' });

    savedOriginals.pm2GetPolicy = PolicyManager2.prototype.getPolicy;
    savedOriginals.dnsAddFilter = DNSMASQ.prototype.addPolicyFilterEntry;
    savedOriginals.dnsRemoveFilter = DNSMASQ.prototype.removePolicyFilterEntry;
    savedOriginals.dnsAddCatFilter = DNSMASQ.prototype.addPolicyCategoryFilterEntry;
    savedOriginals.dnsRemoveCatFilter = DNSMASQ.prototype.removePolicyCategoryFilterEntry;
    savedOriginals.dnsRestart = DNSMASQ.prototype.scheduleRestartDNSService;
  });

  after(() => {
    iptc.addRule = savedOriginals.addRule;

    Tag.ensureCreateEnforcementEnv = savedOriginals.tagEnsure;
    Tag.getTagDeviceSetName = savedOriginals.tagDevSet;
    Tag.getTagNetSetName = savedOriginals.tagNetSet;

    NetworkProfile.ensureCreateEnforcementEnv = savedOriginals.npEnsure;
    NetworkProfile.getNetListIpsetName = savedOriginals.npNetList;

    Host.ensureCreateEnforcementEnv = savedOriginals.hostEnsure;
    Host.getDeviceSetName = savedOriginals.hostDevSet;

    IdentityManager.getIdentityClassByGUID = savedOriginals.idGetClass;
    IdentityManager.getNSAndUID = savedOriginals.idGetNS;

    PolicyManager2.prototype.getPolicy = savedOriginals.pm2GetPolicy;
    DNSMASQ.prototype.addPolicyFilterEntry = savedOriginals.dnsAddFilter;
    DNSMASQ.prototype.removePolicyFilterEntry = savedOriginals.dnsRemoveFilter;
    DNSMASQ.prototype.addPolicyCategoryFilterEntry = savedOriginals.dnsAddCatFilter;
    DNSMASQ.prototype.removePolicyCategoryFilterEntry = savedOriginals.dnsRemoveCatFilter;
    DNSMASQ.prototype.scheduleRestartDNSService = savedOriginals.dnsRestart;
  });

  beforeEach(() => {
    addRuleCalls = [];
    addFilterEntryCalls = [];
    removeFilterEntryCalls = [];
    addCategoryFilterEntryCalls = [];
    removeCategoryFilterEntryCalls = [];
    restartDNSCalled = false;

    // bypassDNSRules / bypassIptablesRules both create `new PolicyManager2()` internally,
    // so patch the prototype rather than a single instance.
    PolicyManager2.prototype.getPolicy = async pid => policyMap[pid] || null;
    iptc.addRule = rule => { addRuleCalls.push(rule); };
    DNSMASQ.prototype.addPolicyFilterEntry = async (targets, opts) => { addFilterEntryCalls.push({ targets, opts }); };
    DNSMASQ.prototype.removePolicyFilterEntry = async (targets, opts) => { removeFilterEntryCalls.push({ targets, opts }); };
    DNSMASQ.prototype.addPolicyCategoryFilterEntry = async opts => { addCategoryFilterEntryCalls.push(opts); };
    DNSMASQ.prototype.removePolicyCategoryFilterEntry = async opts => { removeCategoryFilterEntryCalls.push(opts); };
    DNSMASQ.prototype.scheduleRestartDNSService = async () => { restartDNSCalled = true; };
  });

  // ── ensureCreateBypassChain ───────────────────────────────────────────────

  describe('ensureCreateBypassChain', () => {
    it('creates -N rules for both IPv4 and IPv6', async () => {
      await Bypass.ensureCreateBypassChain('filter', 'c_new1');
      expect(addRuleCalls).to.have.length(2);
    });

    it('is idempotent — second call for same table+pid adds no rules', async () => {
      await Bypass.ensureCreateBypassChain('filter', 'c_idem');
      const after1 = addRuleCalls.length;
      await Bypass.ensureCreateBypassChain('filter', 'c_idem');
      expect(addRuleCalls.length).to.equal(after1);
    });

    it('tracks table independently — filter and mangle are separate keys', async () => {
      await Bypass.ensureCreateBypassChain('filter', 'c_tbl');
      await Bypass.ensureCreateBypassChain('mangle', 'c_tbl');
      expect(addRuleCalls.length).to.equal(4);
    });
  });

  // ── isBypassChainExist ────────────────────────────────────────────────────

  describe('isBypassChainExist', () => {
    it('returns false for a chain that was never created', () => {
      expect(Bypass.isBypassChainExist('filter', 'e_never')).to.equal(false);
    });

    it('returns true after ensureCreateBypassChain', async () => {
      await Bypass.ensureCreateBypassChain('filter', 'e_present');
      expect(Bypass.isBypassChainExist('filter', 'e_present')).to.equal(true);
    });
  });

  // ── removeBypassChain ─────────────────────────────────────────────────────

  describe('removeBypassChain', () => {
    it('returns early when chain does not exist', async () => {
      await Bypass.removeBypassChain('filter', 'r_missing');
      expect(addRuleCalls).to.have.length(0);
    });

    it('issues -F and -X for both families when chain exists', async () => {
      await Bypass.ensureCreateBypassChain('filter', 'r_del');
      addRuleCalls = [];
      await Bypass.removeBypassChain('filter', 'r_del');
      expect(addRuleCalls).to.have.length(4); // -F x2 + -X x2
    });

    it('marks chain as gone after removal', async () => {
      await Bypass.ensureCreateBypassChain('filter', 'r_gone');
      await Bypass.removeBypassChain('filter', 'r_gone');
      expect(Bypass.isBypassChainExist('filter', 'r_gone')).to.equal(false);
    });
  });

  // ── bypassDNSRules ────────────────────────────────────────────────────────

  describe('bypassDNSRules', () => {
    it('enforce non-category: calls addPolicyFilterEntry per policy, first with append:false', async () => {
      policyMap = {
        d1: makePolicy({ type: 'mac', target: 'AA:BB:CC:DD:EE:FF' }),
        d2: makePolicy({ type: 'mac', target: '11:22:33:44:55:66' }),
      };
      await Bypass.bypassDNSRules({
        pid: 'bp1', affectedPids: ['d1', 'd2'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: [], type: 'mac',
      });
      expect(addFilterEntryCalls).to.have.length(2);
      expect(addFilterEntryCalls[0].opts.append).to.equal(false);
      expect(addFilterEntryCalls[1].opts.append).to.equal(true);
      expect(addFilterEntryCalls[0].opts.pid).to.equal('bp1');
      expect(addFilterEntryCalls[0].opts.aPid).to.equal('d1');
      expect(addFilterEntryCalls[0].opts.action).to.equal('bypass');
    });

    it('enforce non-category: calls scheduleRestartDNSService', async () => {
      policyMap = { d3: makePolicy({ type: 'mac' }) };
      await Bypass.bypassDNSRules({
        pid: 'bp1', affectedPids: ['d3'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: [], type: 'mac',
      });
      expect(restartDNSCalled).to.equal(true);
    });

    it('enforce category: deduplicates same category+seq from multiple policies', async () => {
      policyMap = {
        d4: makePolicy({ target: 'social_media', seq: Constants.RULE_SEQ_REG }),
        d5: makePolicy({ target: 'social_media', seq: Constants.RULE_SEQ_REG }),
        d6: makePolicy({ target: 'ads', seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.bypassDNSRules({
        pid: 'bp2', affectedPids: ['d4', 'd5', 'd6'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: ['social_media', 'ads'], type: 'category',
      });
      expect(addCategoryFilterEntryCalls).to.have.length(2);
    });

    it('enforce category: hi-seq and normal-seq of the same name are distinct keys', async () => {
      policyMap = {
        d7: makePolicy({ target: 'social_media', seq: Constants.RULE_SEQ_HI }),
        d8: makePolicy({ target: 'social_media', seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.bypassDNSRules({
        pid: 'bp3', affectedPids: ['d7', 'd8'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: ['social_media'], type: 'category',
      });
      expect(addCategoryFilterEntryCalls).to.have.length(2);
    });

    it('enforce category: first call uses append:false, subsequent use append:true', async () => {
      policyMap = {
        d9: makePolicy({ target: 'ads', seq: Constants.RULE_SEQ_REG }),
        d10: makePolicy({ target: 'games', seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.bypassDNSRules({
        pid: 'bp4', affectedPids: ['d9', 'd10'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: ['ads', 'games'], type: 'category',
      });
      expect(addCategoryFilterEntryCalls[0].append).to.equal(false);
      expect(addCategoryFilterEntryCalls[1].append).to.equal(true);
    });

    it('unenforce category: calls removePolicyCategoryFilterEntry with correct args', async () => {
      policyMap = { d11: makePolicy() };
      await Bypass.bypassDNSRules({
        pid: 'bp5', affectedPids: ['d11'],
        tags: ['t1'], intfs: ['u1'], scope: ['mac1'], guids: ['g1'],
        action: 'unenforce', targets: ['social_media'], type: 'category',
      });
      expect(removeCategoryFilterEntryCalls).to.have.length(1);
      const call = removeCategoryFilterEntryCalls[0];
      expect(call.pid).to.equal('bp5');
      expect(call.action).to.equal('bypass');
      expect(call.categories).to.deep.equal(['social_media']);
      expect(call.tags).to.deep.equal(['t1']);
      expect(call.intfs).to.deep.equal(['u1']);
      expect(call.scope).to.deep.equal(['mac1']);
      expect(call.guids).to.deep.equal(['g1']);
      expect(restartDNSCalled).to.equal(true);
    });

    it('unenforce non-category: calls removePolicyFilterEntry with correct args', async () => {
      policyMap = { d12: makePolicy({ type: 'mac' }) };
      await Bypass.bypassDNSRules({
        pid: 'bp6', affectedPids: ['d12'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'unenforce', targets: ['AA:BB:CC:DD:EE:FF'], type: 'mac',
      });
      expect(removeFilterEntryCalls).to.have.length(1);
      expect(removeFilterEntryCalls[0].opts.pid).to.equal('bp6');
      expect(removeFilterEntryCalls[0].opts.action).to.equal('bypass');
      expect(restartDNSCalled).to.equal(true);
    });

    it('skips missing policies without throwing', async () => {
      policyMap = {};
      await Bypass.bypassDNSRules({
        pid: 'bp7', affectedPids: ['d_miss'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: [], type: 'mac',
      });
      expect(addFilterEntryCalls).to.have.length(0);
    });

    it('does not call scheduleRestartDNSService when no changes made', async () => {
      policyMap = {};
      await Bypass.bypassDNSRules({
        pid: 'bp8', affectedPids: ['d_miss2'],
        tags: [], intfs: [], scope: [], guids: [],
        action: 'enforce', targets: [], type: 'category',
      });
      expect(restartDNSCalled).to.equal(false);
    });
  });

  // ── bypassIptablesRules ───────────────────────────────────────────────────

  describe('bypassIptablesRules', () => {
    it('skips missing policies without throwing', async () => {
      policyMap = {};
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_miss'],
        tags: [], intfs: [], scope: [], guids: [], action: 'enforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(0);
    });

    it('enforce global: creates bypass chain (-N x2) and adds RETURN rules for both families', async () => {
      policyMap = { ip_glob: makePolicy() };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_glob'],
        tags: [], intfs: [], scope: [], guids: [], action: 'enforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(4); // 2 (-N) + 2 (-I RETURN)
    });

    it('unenforce global: no chain creation, adds -D rules for both families', async () => {
      policyMap = { ip_uenf: makePolicy() };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_uenf'],
        tags: [], intfs: [], scope: [], guids: [], action: 'unenforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(2); // 2 (-D RETURN), no -N
    });

    it('enforce with tags: chain + 4 rule types × 2 families per tag', async () => {
      policyMap = { ip_tag: makePolicy() };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_tag'],
        tags: ['tag1'], intfs: [], scope: [], guids: [], action: 'enforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(10); // 2 (-N) + 8 (devSet/netSet × src/dst × fam4/fam6)
    });

    it('enforce with scope: chain + src and dst rules per mac × 2 families', async () => {
      policyMap = { ip_scope: makePolicy() };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_scope'],
        tags: [], intfs: [], scope: ['AA:BB:CC:DD:EE:FF'], guids: [], action: 'enforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(6); // 2 (-N) + 4 (src+dst × fam4+fam6)
    });

    it('enforce with guids: chain + src and dst rules for fam4 and fam6', async () => {
      policyMap = { ip_guid: makePolicy() };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_guid'],
        tags: [], intfs: [], scope: [], guids: ['vpn:client1'], action: 'enforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(6); // 2 (-N) + 4 (set4/set6 × src/dst)
    });

    it('enforce with intfs: chain + src,src and dst,dst rules for fam4 and fam6', async () => {
      policyMap = { ip_intf: makePolicy() };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_intf'],
        tags: [], intfs: ['uuid1'], scope: [], guids: [], action: 'enforce', targets: [], type: 'category',
      });
      expect(addRuleCalls).to.have.length(6); // 2 (-N) + 4 (src,src/dst,dst × fam4/fam6)
    });

    it('unknown guid is skipped — only chain creation rules added', async () => {
      policyMap = { ip_unk: makePolicy() };
      const savedGetClass = IdentityManager.getIdentityClassByGUID;
      IdentityManager.getIdentityClassByGUID = () => null;
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_unk'],
        tags: [], intfs: [], scope: [], guids: ['unknown:guid'], action: 'enforce', targets: [], type: 'category',
      });
      IdentityManager.getIdentityClassByGUID = savedGetClass;
      expect(addRuleCalls).to.have.length(2); // only -N, no RETURN rules
    });

    it('multiple affected policies each get their own chain and rules', async () => {
      policyMap = {
        ip_m1: makePolicy(),
        ip_m2: makePolicy(),
      };
      await Bypass.bypassIptablesRules({
        pid: 'bp1', affectedPids: ['ip_m1', 'ip_m2'],
        tags: [], intfs: [], scope: [], guids: [], action: 'enforce', targets: [], type: 'category',
      });
      // ip_m1: 2(-N) + 2(RETURN) = 4; ip_m2: 2(-N) + 2(RETURN) = 4
      expect(addRuleCalls).to.have.length(8);
    });
  });
});
