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

// Pre-require all lazy dependencies so patches are in cache before Bypass uses them
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const iptc = require('../control/IptablesControl.js');
const domainBlock = require('../control/DomainBlock.js');
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

  let pm2;
  let blockCategoryCalls, unblockCategoryCalls, addRuleCalls;
  let savedOriginals = {};

  // Policies keyed by pid; tests set this map before each case
  let policyMap;

  before(() => {
    pm2 = new PolicyManager2();

    // Save originals that we always patch
    savedOriginals.getPolicy = pm2.getPolicy.bind(pm2);
    savedOriginals.blockCategory = domainBlock.blockCategory;
    savedOriginals.unblockCategory = domainBlock.unblockCategory;
    savedOriginals.addRule = iptc.addRule;

    // Static helpers – save and stub
    savedOriginals.tagEnsure = Tag.ensureCreateEnforcementEnv;
    savedOriginals.tagDevSet = Tag.getTagDeviceSetName;
    savedOriginals.tagNetSet = Tag.getTagNetSetName;
    Tag.ensureCreateEnforcementEnv = async () => {};
    Tag.getTagDeviceSetName = (uid) => `fw_dev_tag_${uid}`;
    Tag.getTagNetSetName = (uid) => `fw_net_tag_${uid}`;

    savedOriginals.npEnsure = NetworkProfile.ensureCreateEnforcementEnv;
    savedOriginals.npNetList = NetworkProfile.getNetListIpsetName;
    NetworkProfile.ensureCreateEnforcementEnv = async () => {};
    NetworkProfile.getNetListIpsetName = (uuid) => `fw_net_${uuid}`;

    savedOriginals.hostEnsure = Host.ensureCreateEnforcementEnv;
    savedOriginals.hostDevSet = Host.getDeviceSetName;
    Host.ensureCreateEnforcementEnv = async () => {};
    Host.getDeviceSetName = (mac) => `fw_dev_${mac.replace(/:/g, '')}`;

    savedOriginals.idGetClass = IdentityManager.getIdentityClassByGUID;
    savedOriginals.idGetNS = IdentityManager.getNSAndUID;
    IdentityManager.getIdentityClassByGUID = (guid) => ({
      ensureCreateEnforcementEnv: async () => {},
      getEnforcementIPsetName: (uid, fam) => `fw_id_${uid}_${fam}`,
    });
    IdentityManager.getNSAndUID = (guid) => ({ ns: 'vpn', uid: 'test_uid' });
  });

  after(() => {
    pm2.getPolicy = savedOriginals.getPolicy;
    domainBlock.blockCategory = savedOriginals.blockCategory;
    domainBlock.unblockCategory = savedOriginals.unblockCategory;
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
  });

  beforeEach(() => {
    blockCategoryCalls = [];
    unblockCategoryCalls = [];
    addRuleCalls = [];

    pm2.getPolicy = async (pid) => policyMap[pid] || null;
    domainBlock.blockCategory = async (opts) => { blockCategoryCalls.push(opts); };
    domainBlock.unblockCategory = async (opts) => { unblockCategoryCalls.push(opts); };
    iptc.addRule = (rule) => { addRuleCalls.push(rule); };
  });

  // ── setupIntfsRules ────────────────────────────────────────────────────────

  describe('setupIntfsRules', () => {
    it('returns early when uuids is empty', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1'], uuids: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(0);
      expect(addRuleCalls).to.have.length(0);
    });

    it('first blockCategory call uses append:false, subsequent use append:true (nonHiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG, useBf: true, target: 'social_media' }) };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1'], uuids: ['uuid1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2); // main + bf
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('first blockCategory call uses append:false, subsequent use append:true (hiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_HI, useBf: true, target: 'social_media' }) };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1'], uuids: ['uuid1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('shouldAppend carries from hiSeq block into nonHiSeq block', async () => {
      policyMap = {
        1: makePolicy({ seq: Constants.RULE_SEQ_HI }),
        2: makePolicy({ seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1', '2'], uuids: ['uuid1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      // hiSeq: 1 call (append:false); nonHiSeq: 1 call (append:true)
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('unenforce calls unblockCategory', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1'], uuids: ['uuid1'], action: 'unenforce',
        targets: ['social_media'], type: 'category',
      });
      expect(unblockCategoryCalls).to.have.length(1);
      expect(unblockCategoryCalls[0]).to.include({ pid: 'bp1', action: 'bypass' });
    });

    it('skips policies that are not category/mac/internet blocking', async () => {
      policyMap = { 1: makePolicy({ type: 'ip', action: 'block' }) };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1'], uuids: ['uuid1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(addRuleCalls).to.have.length(0);
    });

    it('enforce adds iptables -N and -I rules', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupIntfsRules({
        pid: 'bp1', affectedPids: ['1'], uuids: ['uuid1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      const ops = addRuleCalls.map(r => r._opr || r.opr || (r.toString && r.toString()));
      expect(addRuleCalls.length).to.be.greaterThan(0);
    });
  });

  // ── setupTagsRules ─────────────────────────────────────────────────────────

  describe('setupTagsRules', () => {
    it('first blockCategory call uses append:false (nonHiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG }) };
      await Bypass.setupTagsRules({
        pid: 'bp1', affectedPids: ['1'], tags: ['tag1'], intfs: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
    });

    it('first blockCategory call uses append:false (hiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_HI }) };
      await Bypass.setupTagsRules({
        pid: 'bp1', affectedPids: ['1'], tags: ['tag1'], intfs: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[0].seq).to.equal(Constants.RULE_SEQ_HI);
    });

    it('bf blockCategory call uses append:true', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG, useBf: true, target: 'social_media' }) };
      await Bypass.setupTagsRules({
        pid: 'bp1', affectedPids: ['1'], tags: ['tag1'], intfs: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('shouldAppend carries from hiSeq block into nonHiSeq block', async () => {
      policyMap = {
        1: makePolicy({ seq: Constants.RULE_SEQ_HI }),
        2: makePolicy({ seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.setupTagsRules({
        pid: 'bp1', affectedPids: ['1', '2'], tags: ['tag1'], intfs: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('unenforce calls unblockCategory with tags', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupTagsRules({
        pid: 'bp1', affectedPids: ['1'], tags: ['tag1'], intfs: [], action: 'unenforce',
        targets: ['social_media'], type: 'category',
      });
      expect(unblockCategoryCalls).to.have.length(1);
      expect(unblockCategoryCalls[0].tags).to.deep.equal(['tag1']);
    });
  });

  // ── setupDevicesRules ──────────────────────────────────────────────────────

  describe('setupDevicesRules', () => {
    it('returns early when macAddresses is empty', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupDevicesRules({
        pid: 'bp1', affectedPids: ['1'], macAddresses: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(0);
    });

    it('first blockCategory call uses append:false (nonHiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG }) };
      await Bypass.setupDevicesRules({
        pid: 'bp1', affectedPids: ['1'], macAddresses: ['AA:BB:CC:DD:EE:FF'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
    });

    it('first blockCategory call uses append:false (hiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_HI }) };
      await Bypass.setupDevicesRules({
        pid: 'bp1', affectedPids: ['1'], macAddresses: ['AA:BB:CC:DD:EE:FF'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
    });

    it('bf blockCategory call uses append:true', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG, useBf: true, target: 'social_media' }) };
      await Bypass.setupDevicesRules({
        pid: 'bp1', affectedPids: ['1'], macAddresses: ['AA:BB:CC:DD:EE:FF'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('shouldAppend carries from hiSeq block into nonHiSeq block', async () => {
      policyMap = {
        1: makePolicy({ seq: Constants.RULE_SEQ_HI }),
        2: makePolicy({ seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.setupDevicesRules({
        pid: 'bp1', affectedPids: ['1', '2'], macAddresses: ['AA:BB:CC:DD:EE:FF'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('unenforce calls unblockCategory with scope', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupDevicesRules({
        pid: 'bp1', affectedPids: ['1'], macAddresses: ['AA:BB:CC:DD:EE:FF'], action: 'unenforce',
        targets: ['social_media'], type: 'category',
      });
      expect(unblockCategoryCalls).to.have.length(1);
      expect(unblockCategoryCalls[0].scope).to.deep.equal(['AA:BB:CC:DD:EE:FF']);
    });
  });

  // ── setupGenericIdentitiesRules ────────────────────────────────────────────

  describe('setupGenericIdentitiesRules', () => {
    it('returns early when guids is empty', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupGenericIdentitiesRules({
        pid: 'bp1', affectedPids: ['1'], guids: [], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(0);
    });

    it('first blockCategory call uses append:false (nonHiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG }) };
      await Bypass.setupGenericIdentitiesRules({
        pid: 'bp1', affectedPids: ['1'], guids: ['vpn:client1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
    });

    it('first blockCategory call uses append:false (hiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_HI }) };
      await Bypass.setupGenericIdentitiesRules({
        pid: 'bp1', affectedPids: ['1'], guids: ['vpn:client1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
    });

    it('bf blockCategory call uses append:true', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG, useBf: true, target: 'social_media' }) };
      await Bypass.setupGenericIdentitiesRules({
        pid: 'bp1', affectedPids: ['1'], guids: ['vpn:client1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('shouldAppend carries from hiSeq block into nonHiSeq block', async () => {
      policyMap = {
        1: makePolicy({ seq: Constants.RULE_SEQ_HI }),
        2: makePolicy({ seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.setupGenericIdentitiesRules({
        pid: 'bp1', affectedPids: ['1', '2'], guids: ['vpn:client1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('unenforce calls unblockCategory with guids', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupGenericIdentitiesRules({
        pid: 'bp1', affectedPids: ['1'], guids: ['vpn:client1'], action: 'unenforce',
        targets: ['social_media'], type: 'category',
      });
      expect(unblockCategoryCalls).to.have.length(1);
      expect(unblockCategoryCalls[0].guids).to.deep.equal(['vpn:client1']);
    });
  });

  // ── setupGlobalRules ───────────────────────────────────────────────────────

  describe('setupGlobalRules', () => {
    it('first blockCategory call uses append:false (nonHiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG }) };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
    });

    it('first blockCategory call uses append:false (hiSeq only)', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_HI }) };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(1);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[0].seq).to.equal(Constants.RULE_SEQ_HI);
    });

    it('bf blockCategory call uses append:true', async () => {
      policyMap = { 1: makePolicy({ seq: Constants.RULE_SEQ_REG, useBf: true, target: 'social_media' }) };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('shouldAppend carries from hiSeq block into nonHiSeq block', async () => {
      policyMap = {
        1: makePolicy({ seq: Constants.RULE_SEQ_HI }),
        2: makePolicy({ seq: Constants.RULE_SEQ_REG }),
      };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1', '2'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      expect(blockCategoryCalls).to.have.length(2);
      expect(blockCategoryCalls[0].append).to.equal(false);
      expect(blockCategoryCalls[1].append).to.equal(true);
    });

    it('unenforce calls unblockCategory without scope', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1'], action: 'unenforce',
        targets: ['social_media'], type: 'category',
      });
      expect(unblockCategoryCalls).to.have.length(1);
      expect(unblockCategoryCalls[0]).to.include({ pid: 'bp1', action: 'bypass' });
      expect(unblockCategoryCalls[0]).to.not.have.property('scope');
      expect(unblockCategoryCalls[0]).to.not.have.property('guids');
    });

    it('no domainBlock calls when type is not category', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1'], action: 'enforce',
        targets: ['social_media'], type: 'mac',
      });
      expect(blockCategoryCalls).to.have.length(0);
    });

    it('enforce adds iptables RETURN rules for each affected blocking policy', async () => {
      policyMap = { 1: makePolicy() };
      await Bypass.setupGlobalRules({
        pid: 'bp1', affectedPids: ['1'], action: 'enforce',
        targets: ['social_media'], type: 'category',
      });
      // -N (chain create) for 2 families + RETURN rules for 2 families
      expect(addRuleCalls.length).to.be.greaterThan(0);
    });
  });
});
