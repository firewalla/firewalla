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

'use strict'

let chai = require('chai');
let expect = chai.expect;

const Tag = require('../net2/Tag.js');
const tagManager = require('../net2/TagManager.js');
const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();



describe('Test InternalScanSensor', function() {
  this.timeout(3000);

  beforeEach((done) => {
    (async() =>{
        const currentTs = Date.now() / 1000;
        tagManager.tags['88']= new Tag({uid: 88, name: '', createTs: currentTs});
        tagManager.tags['99']= new Tag({uid: 99, name: 'tag99', createTs: currentTs});
        await rclient.hsetAsync('policy:tag:88', 'feature1', '{"attr1": "1111"}');
        await rclient.hsetAsync('policy:tag:99', 'feature2', '{');
        done();
    })();
  });

  afterEach((done) => {
    (async() => {
      await rclient.delAsync('policy:tag:88');
      await rclient.delAsync('policy:tag:99');
      done();
    })();
  });

  describe('Test TagManager', async() => {
    it('should get tag', () => {
      expect(tagManager.getTag(88).getUniqueId()).to.be.equal(88);
      expect(tagManager.getTag('tag99').getUniqueId()).to.be.equal(99);
    });

    it('should check has policy', async () => {
      expect(await tagManager.tags['88'].hasPolicyAsync('feature1')).to.be.true;
      expect(await tagManager.tags['88'].hasPolicyAsync('feature2')).to.be.false;
    });

    it('should get policy tags', async () => {
      const tags = await tagManager.getPolicyTags('feature1');
      expect(tags.length).to.be.equal(1);
      expect(tags[0].o.uid).to.be.equal(88);
    });

    it ('should get policy', async() => {
      const feature1 = await tagManager.tags['88'].getPolicyAsync('feature1');
      expect(feature1.attr1).to.be.equal('1111');

      const feature2 = await tagManager.tags['99'].getPolicyAsync('feature1');
      expect(feature2).to.be.null;
    });
  });

  describe('_getNextTagUid', function() {
    beforeEach(async() => {
      const currentUid = await rclient.getAsync('tag:uid');
      this.currentUid = currentUid;
    });

    afterEach(async() => {
      await rclient.setAsync('tag:uid', this.currentUid);
    });

    it('should return the value stored in tag:uid and increment the counter', async() => {
      const uid = await tagManager._getNextTagUid();
      expect(uid).to.equal(this.currentUid, 'return value should equal the value that was in tag:uid');
      const afterValue = await rclient.getAsync('tag:uid');
      expect(Number(afterValue)).to.equal(Number(this.currentUid) + 1, 'tag:uid should be incremented by 1 after the call');
    });

    it('_getNextTagUid should always return different uids even called concurrently', async() => {
      const concurrency = 100;
      const promises = Array(concurrency).fill(null).map(() => tagManager._getNextTagUid());
      const uids = await Promise.all(promises);

      const uniqueUids = new Set(uids);
      expect(uniqueUids.size).to.equal(concurrency, 'all concurrent _getNextTagUid() calls should return different values');
      expect(uids.length).to.equal(concurrency);

      const currentUid = await rclient.getAsync('tag:uid');
      expect(Number(currentUid)).to.equal(Number(this.currentUid) + concurrency);
    });
  });

});

// policy:tag:<uid> and the tag ipsets are keyed by uid alone, so a deviceTag sharing its uid with a
// group is hidden behind the group and gets created again under a new uid on every device detection
describe('Test TagManager deviceTag sharing its uid with another tag type', function() {
  const proxyquire = require('proxyquire');

  // TagManager against an in-memory redis, the tags of the box running the test are not touched
  function loadTagManager(isMain, sets, hashes) {
    const calls = { srem: [], unlink: [], destroyed: [] };
    const redis = {
      smembersAsync: async (key) => Array.from(sets[key] || []),
      hgetallAsync: async (key) => hashes[key] ? Object.assign({}, hashes[key]) : null,
      sremAsync: async (key, uid) => { calls.srem.push([key, uid]); sets[key] && sets[key].delete(uid); },
      unlinkAsync: async (key) => { calls.unlink.push(key); delete hashes[key]; },
    };
    class FakeTag {
      constructor(o) { this.o = o; }
      static parse(o) { return o; }
      async update(o) { this.o = o; }
      getTagType() { return this.o.type || 'group'; }
      async destroy() { calls.destroyed.push(this.o.uid); }
      async resetPolicies() {}
      async destroyEnv() {}
    }
    const tm = proxyquire('../net2/TagManager.js', {
      '../util/redis_manager.js': { getRedisClient: () => redis },
      './Firewalla.js': { isMain: () => isMain, isApi: () => false },
      './SysManager.js': { isIptablesReady: () => false, waitTillIptablesReady: async () => {} },
      './Tag.js': FakeTag,
      '../extension/dnsmasq/dnsmasq.js': class { async writeAllocationOption() {} },
      './MessageBus.js': class { subscribeOnce() {} publish() {} },
    });
    clearTimeout(tm.refreshTask);
    return { tm, calls };
  }

  function collidingBox() {
    return {
      sets: {
        'tag:group:active': new Set(['10']),
        'tag:device:active': new Set(['10', '11']),
      },
      hashes: {
        'tag:uid:10': { uid: '10', name: 'Cameras' },
        'deviceTag:uid:10': { uid: '10', name: 'desktop', type: 'device' },
        'deviceTag:uid:11': { uid: '11', name: 'phone', type: 'device' },
      }
    };
  }

  it('should remove the deviceTag and keep the group in FireMain', async () => {
    const { sets, hashes } = collidingBox();
    const { tm, calls } = loadTagManager(true, sets, hashes);
    await tm.refreshTags();

    expect(calls.srem).to.eql([['tag:device:active', '10']]);
    expect(calls.unlink).to.eql(['deviceTag:uid:10']);
    expect(hashes['tag:uid:10']).to.eql({ uid: '10', name: 'Cameras' });
    expect(Array.from(sets['tag:group:active'])).to.eql(['10']);
    expect(tm.getTagByUid('10').o.name).to.equal('Cameras');
    expect(tm.getTagByUid('10').getTagType()).to.equal('group');
    expect(tm.getTagByUid('11').o.name).to.equal('phone');
    // the group still owns uid 10, its policy and ipsets must not be torn down
    expect(calls.destroyed).to.eql([]);
  });

  it('should keep the deviceTag that is created again under a new uid', async () => {
    const { sets, hashes } = collidingBox();
    const { tm, calls } = loadTagManager(true, sets, hashes);
    await tm.refreshTags();
    expect(tm.getTagByName('desktop', 'device')).to.be.null;

    // what createTag does for the next detected desktop
    sets['tag:device:active'].add('12');
    hashes['deviceTag:uid:12'] = { uid: '12', name: 'desktop', type: 'device' };
    await tm.refreshTags();

    expect(Array.from(sets['tag:device:active']).sort()).to.eql(['11', '12']);
    expect(tm.getTagByName('desktop', 'device').o.uid).to.equal('12');
    expect(calls.unlink).to.eql(['deviceTag:uid:10']);
    expect(calls.destroyed).to.eql([]);
  });

  it('should hide the deviceTag without changing redis outside FireMain', async () => {
    const { sets, hashes } = collidingBox();
    const { tm, calls } = loadTagManager(false, sets, hashes);
    await tm.refreshTags();

    expect(calls.srem).to.eql([]);
    expect(calls.unlink).to.eql([]);
    expect(tm.getTagByUid('10').o.name).to.equal('Cameras');
    expect(tm.getTagByName('desktop', 'device')).to.be.null;
  });

  it('should leave tags alone when no uid is shared', async () => {
    const { sets, hashes } = collidingBox();
    sets['tag:group:active'] = new Set(['9']);
    hashes['tag:uid:9'] = { uid: '9', name: 'Cameras' };
    delete hashes['tag:uid:10'];
    const { tm, calls } = loadTagManager(true, sets, hashes);
    await tm.refreshTags();

    expect(calls.srem).to.eql([]);
    expect(calls.unlink).to.eql([]);
    expect(Object.keys(tm.tags).sort()).to.eql(['10', '11', '9']);
    expect(tm.getTagByName('desktop', 'device').o.uid).to.equal('10');
  });
});

// destroyEnv() used to only flush tag ipsets, leaving empty orphaned ipsets behind forever
describe('Test Tag destroyEnv ipset cleanup', function() {
  this.timeout(5000);

  it('should remove tag ipsets after the tag is deleted, not leave them behind empty', async () => {
    const Ipset = require('../net2/Ipset.js');
    const origDestroy = Ipset.destroy;
    const origFlush = Ipset.flush;
    const destroyed = [];
    Ipset.destroy = (setName) => { destroyed.push(setName); return Promise.resolve(); };
    Ipset.flush = (setName) => { throw new Error(`Ipset ${setName} was only flushed, not removed - it will linger as an empty orphaned ipset after the tag is deleted`); };

    const uid = 'testTagDestroy';
    const tag = new Tag({uid, name: 'testTagDestroy', createTs: Date.now() / 1000});
    try {
      await tag.destroyEnv();
    } finally {
      Ipset.destroy = origDestroy;
      Ipset.flush = origFlush;
    }

    const expectedSets = [
      Tag.getTagSetName(uid),
      Tag.getTagDeviceSetName(uid),
      Tag.getTagNetSetName(uid),
      Tag.getTagDeviceMacSetName(uid),
      Tag.getTagDeviceIPSetName(uid, 4),
      Tag.getTagDeviceIPSetName(uid, 6),
    ];
    expect(destroyed).to.include.members(expectedSets);

    // dev_mac_set is a member of tag_set and dev_set, so those containers must be
    // destroyed first or Ipset.destroy()'s isReferenced() check would skip dev_mac_set
    const macSetIdx = destroyed.indexOf(Tag.getTagDeviceMacSetName(uid));
    expect(destroyed.indexOf(Tag.getTagSetName(uid))).to.be.below(macSetIdx);
    expect(destroyed.indexOf(Tag.getTagDeviceSetName(uid))).to.be.below(macSetIdx);
  });

  // a user tag's containers hold its affiliated group tag's device sets as members
  // (Tag.tags()); deleting the group tag without unlinking left them referenced forever
  it('should unlink its device sets from an affiliated parent tag before destroying them', async () => {
    const Ipset = require('../net2/Ipset.js');
    const Constants = require('../net2/Constants.js');
    const origDestroy = Ipset.destroy;
    const origDel = Ipset.del;
    const deleted = [];
    Ipset.destroy = () => Promise.resolve();
    Ipset.del = (setName, member) => { deleted.push([setName, member]); return Promise.resolve(); };

    const uid = 'testAffiliatedChild';
    const parentUid = 'testAffiliatedParent';
    const tag = new Tag({ uid, name: uid, createTs: Date.now() / 1000 });
    await tag.loadPolicyAsync();
    tag.policy[Constants.TAG_TYPE_MAP.user.policyKey] = [parentUid];

    try {
      await tag.destroyEnv();
    } finally {
      Ipset.destroy = origDestroy;
      Ipset.del = origDel;
    }

    const wasUnlinked = (setName, member) => deleted.some(([s, m]) => s === setName && m === member);
    for (const parentSetName of [Tag.getTagDeviceSetName(parentUid), Tag.getTagSetName(parentUid)]) {
      expect(wasUnlinked(parentSetName, Tag.getTagDeviceMacSetName(uid))).to.be.true;
      expect(wasUnlinked(parentSetName, Tag.getTagDeviceIPSetName(uid, 4))).to.be.true;
      expect(wasUnlinked(parentSetName, Tag.getTagDeviceIPSetName(uid, 6))).to.be.true;
    }
  });
});
