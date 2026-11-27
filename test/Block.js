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

// a quarantine group's rules are rendered a second time for devices on a quarantine-on network
// the box has not decided about yet: the group's device set is replaced by the network set with
// the decided devices excluded, by MAC on the source side and by address on the destination side

const { expect } = require('chai');
const Ipset = require('../net2/Ipset.js');
const iptc = require('../control/IptablesControl.js');
const Tag = require('../net2/Tag.js');
const Block = require('../control/Block.js');

const C = Ipset.CONSTANTS;

describe('Block.setupTagsRules undecided-device copies', function () {
  this.timeout(5000);

  let rules;
  const saved = {};

  before(() => {
    saved.addRule = iptc.addRule;
    saved.addRuleBatch = iptc.addRuleBatch;
    saved.tagEnsure = Tag.ensureCreateEnforcementEnv;
    saved.tagDevSet = Tag.getTagDeviceSetName;
    saved.tagNetSet = Tag.getTagNetSetName;
    iptc.addRule = async rule => { rules.push(rule); };
    iptc.addRuleBatch = async () => {};
    Tag.ensureCreateEnforcementEnv = async () => {};
    Tag.getTagDeviceSetName = uid => `c_tag_${uid}_dev_set`;
    Tag.getTagNetSetName = uid => `c_tag_${uid}_net_set`;
  });

  after(() => {
    iptc.addRule = saved.addRule;
    iptc.addRuleBatch = saved.addRuleBatch;
    Tag.ensureCreateEnforcementEnv = saved.tagEnsure;
    Tag.getTagDeviceSetName = saved.tagDevSet;
    Tag.getTagNetSetName = saved.tagNetSet;
  });

  beforeEach(() => {
    rules = [];
  });

  function render(options) {
    return Block.setupTagsRules(Object.assign({
      pid: 'p1', uids: ['16'], remoteSet4: 'c_bd_p1_set', remoteSet6: 'c_bd_p1_set6',
      action: 'block', direction: 'bidirection',
    }, options));
  }

  const text = rule => rule.essential();
  const composite = () => rules.filter(rule => text(rule).includes(C.IPSET_NEW_DEV_NETWORK));

  it('renders no copy for a group that is not a quarantine group', async () => {
    await render({});
    expect(rules).to.have.length(8); // devSet and netSet, each src and dst, each v4 and v6
    expect(composite()).to.have.length(0);
    for (const rule of rules)
      expect(text(rule)).to.not.include('new_dev');
  });

  it('adds the source and the destination copy next to the member rules', async () => {
    await render({ newDeviceTagUids: ['16'] });
    expect(rules).to.have.length(12);
    const copies = composite();
    expect(copies).to.have.length(4);
    const src = copies.filter(rule => text(rule).includes(`--match-set ${C.IPSET_NEW_DEV_NETWORK} src,src`));
    const dst = copies.filter(rule => text(rule).includes(`--match-set ${C.IPSET_NEW_DEV_NETWORK} dst,dst`));
    expect(src).to.have.length(2);
    expect(dst).to.have.length(2);
    for (const rule of src) {
      expect(text(rule)).to.include(`-m set ! --match-set ${C.IPSET_NEW_DEV_EXEMPT_MAC} src`);
      expect(text(rule)).to.not.include('--ctdir');
    }
    for (const rule of dst) {
      expect(text(rule)).to.include(`-m set ! --match-set ${C.IPSET_NEW_DEV_EXEMPT} dst`);
      expect(text(rule)).to.include('--ctdir ORIGINAL');
      expect(text(rule)).to.not.include(C.IPSET_NEW_DEV_EXEMPT_MAC);
    }
    expect(dst.map(rule => rule.family)).to.have.members([4, 6]);
    // the member rules are the same as without the copies
    for (const rule of rules.filter(rule => !composite().includes(rule)))
      expect(text(rule)).to.not.include('new_dev');
  });

  it('never renders the destination copy for the reply direction', async () => {
    await render({ newDeviceTagUids: ['16'], direction: 'outbound' });
    const copies = composite();
    expect(copies).to.have.length(2);
    for (const rule of copies) {
      expect(text(rule)).to.include(`--match-set ${C.IPSET_NEW_DEV_NETWORK} src,src`);
      expect(text(rule)).to.not.include('--ctdir REPLY');
    }
    // the member rules still carry their reply-direction copy
    expect(rules.filter(rule => text(rule).includes('--ctdir REPLY'))).to.have.length(4);
  });

  it('keeps the direction the rule already carries on the destination copy', async () => {
    await render({ newDeviceTagUids: ['16'], direction: 'inbound' });
    const dst = composite().filter(rule => text(rule).includes(`--match-set ${C.IPSET_NEW_DEV_NETWORK} dst,dst`));
    expect(dst).to.have.length(2);
    for (const rule of dst)
      expect(text(rule).match(/--ctdir/g)).to.have.length(1);
  });

  it('copies once for the quarantine group only, whatever the uid type', async () => {
    await render({ uids: ['16', '49'], newDeviceTagUids: [49] });
    expect(rules).to.have.length(20);
    const copies = composite();
    expect(copies).to.have.length(4);
    for (const rule of composite())
      expect(text(rule)).to.not.include('c_tag_');
    const members = rules.filter(rule => !copies.includes(rule));
    expect(members.filter(rule => text(rule).includes('c_tag_16_'))).to.have.length(8);
    expect(members.filter(rule => text(rule).includes('c_tag_49_'))).to.have.length(8);
  });

  it('deletes the copies on destroy even when the group is no longer a quarantine group', async () => {
    await render({ createOrDestroy: 'destroy' });
    expect(rules).to.have.length(12);
    const copies = composite();
    expect(copies).to.have.length(4);
    for (const rule of rules)
      expect(rule.operation).to.equal('-D');
  });
});
