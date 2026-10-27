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

'use strict'

const { expect } = require('chai');
const rclient = require('../util/redis_manager.js').getRedisClient();
const DNSTool = require('../net2/DNSTool.js');
const CategoryUpdater = require('../control/CategoryUpdater.js');
const OldDataCleanSensor = require('../sensor/OldDataCleanSensor.js');

// a subdomain list larger than the max number of function arguments (~125k on node 12)
// used to crash category ipset recycle with "RangeError: Maximum call stack size exceeded"
// it is seeded directly into subdomains2:<suffix>, bypassing the size limit of addSubDomains
const SUFFIX = 'fwtest-pattern-expansion.com';
const SUBDOMAIN_KEY = `subdomains2:${SUFFIX}`;
const SUBDOMAIN_COUNT = 200000;
const RDNS_COUNT = 20000;
const IP_POOL = 3000;

function ipOf(j) {
  return `198.18.${Math.floor(j / 256)}.${j % 256}`;
}

async function unlinkByPattern(pattern) {
  const keys = await rclient.scanResults(pattern);
  for (let i = 0; i < keys.length; i += 1000)
    await rclient.unlinkAsync(keys.slice(i, i + 1000));
}

describe('Test large domain pattern expansion', function() {
  this.timeout(120000);

  const dnsTool = new DNSTool();
  const categoryUpdater = new CategoryUpdater();
  const expectedIPs = new Set();
  const latestScore = {};

  before(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX}`);
    await rclient.unlinkAsync(SUBDOMAIN_KEY, `srdns:pattern:${SUFFIX}`);

    const names = [];
    for (let i = 0; i < SUBDOMAIN_COUNT; i++)
      names.push(`n${i}.${SUFFIX}`);
    const now = Date.now() / 1000;
    for (let i = 0; i < names.length; i += 1000) {
      const args = [SUBDOMAIN_KEY];
      for (const n of names.slice(i, i + 1000))
        args.push(now, n);
      await rclient.zaddAsync(args);
    }

    const cmds = [];
    for (let i = 0; i < RDNS_COUNT; i++) {
      const ip = ipOf(i % IP_POOL);
      const score = 1000 + i;
      expectedIPs.add(ip);
      latestScore[ip] = Math.max(latestScore[ip] || 0, score);
      cmds.push(['zadd', `rdns:domain:${names[i]}`, score, ip]);
      if (cmds.length >= 1000)
        await rclient.pipelineAndLog(cmds.splice(0));
    }
    if (cmds.length)
      await rclient.pipelineAndLog(cmds);
  });

  after(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX}`);
    await rclient.unlinkAsync(SUBDOMAIN_KEY, `srdns:pattern:${SUFFIX}`);
  });

  it('getIPsByDomainPattern should return deduplicated IPs without throwing', async () => {
    const ips = await dnsTool.getIPsByDomainPattern(SUFFIX);
    expect(ips.length).to.equal(expectedIPs.size);
    // chai 3 deep equal does not compare Set content, compare sorted arrays instead
    expect(ips.slice().sort()).to.deep.equal(Array.from(expectedIPs).sort());
  });

  it('unionDomainMappings should merge all mappings in chunks with latest score', async () => {
    const mappings = await categoryUpdater.getDomainMappingsByDomainPattern(`*.${SUFFIX}`);
    expect(mappings.length).to.be.above(SUBDOMAIN_COUNT);

    const dest = categoryUpdater.getSummedDomainMapping(`*.${SUFFIX}`);
    await rclient.zaddAsync(dest, 1, 'stale.ip'); // must be overwritten, not merged
    await categoryUpdater.unionDomainMappings(dest, mappings);

    const result = await rclient.zrangeAsync(dest, 0, -1, 'WITHSCORES');
    const merged = {};
    for (let i = 0; i < result.length; i += 2)
      merged[result[i]] = Number(result[i + 1]);
    expect(Object.keys(merged).length).to.equal(expectedIPs.size);
    expect(merged).to.deep.equal(latestScore);
  });

  it('getIPsByDomainMappings should return complete IPs when another call on the same pattern runs before the read', async () => {
    const mappings = await categoryUpdater.getDomainMappingsByDomainPattern(`*.${SUFFIX}`);
    // categories sharing a pattern are recycled concurrently, with a shared dest key another call's first chunk
    // could overwrite a finished union before it is read. Timing based concurrency rarely hits that window,
    // so run another call on the same pattern right between the union and the read of this call
    const union = categoryUpdater.unionDomainMappings;
    let other = null;
    categoryUpdater.unionDomainMappings = async function(dest, m) {
      await union.call(this, dest, m);
      if (!other) {
        other = this.getIPsByDomainMappings(`*.${SUFFIX}`, mappings.slice(0, 1));
        await other;
      }
    };
    try {
      const ips = await categoryUpdater.getIPsByDomainMappings(`*.${SUFFIX}`, mappings);
      expect(ips.slice().sort()).to.deep.equal(Array.from(expectedIPs).sort());
      expect((await other).length).to.be.below(expectedIPs.size);
    } finally {
      categoryUpdater.unionDomainMappings = union;
    }
    expect(await rclient.scanResults(`srdns:pattern:${SUFFIX}:*`)).to.be.empty;
  });

  it('unionDomainMappings should never leave dest without TTL between chunks', async () => {
    const mappings = await categoryUpdater.getDomainMappingsByDomainPattern(`*.${SUFFIX}`);
    const dest = `srdns:pattern:${SUFFIX}:ttltest`;
    await rclient.unlinkAsync(dest);
    // ZUNIONSTORE drops the TTL of dest, if the process dies between chunks a key without TTL is left forever
    try {
      let done = false;
      const union = categoryUpdater.unionDomainMappings(dest, mappings).then(() => { done = true; });
      const ttls = [];
      while (!done)
        ttls.push(await rclient.ttlAsync(dest));
      await union;
      expect(ttls.filter(t => t !== -2).length).to.be.above(0);
      expect(ttls).to.not.include(-1);
      expect(await rclient.ttlAsync(dest)).to.be.within(1, 600);
    } finally {
      await rclient.unlinkAsync(dest);
    }
  });

  it('unionDomainMappings should leave no key when no mapping exists', async () => {
    const dest = `srdns:pattern:${SUFFIX}`;
    await categoryUpdater.unionDomainMappings(dest, [`rdns:domain:none1.${SUFFIX}`, `rdns:domain:none2.${SUFFIX}`]);
    expect(await rclient.typeAsync(dest)).to.equal('none');
  });
});

describe('Test subdomains2 zset lifecycle', function() {
  this.timeout(60000);

  const dnsTool = new DNSTool();
  const SUFFIX2 = 'fwtest-subdomains2.com';
  const KEY2 = `subdomains2:${SUFFIX2}`;
  const LEGACY_KEY2 = `subdomains:${SUFFIX2}`;

  beforeEach(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX2}`);
    await rclient.unlinkAsync(KEY2, LEGACY_KEY2);
  });

  after(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX2}`);
    await rclient.unlinkAsync(KEY2, LEGACY_KEY2);
  });

  it('getSubDomains should be read only, OldDataCleanSensor drops names not seen in 24 hours', async () => {
    const now = Date.now() / 1000;
    await rclient.zaddAsync(KEY2, now - 2 * 86400, `old.${SUFFIX2}`, now, `fresh.${SUFFIX2}`);
    expect((await dnsTool.getSubDomains(SUFFIX2)).sort()).to.deep.equal([`fresh.${SUFFIX2}`, `old.${SUFFIX2}`]);

    const batch = [];
    await OldDataCleanSensor.prototype.cleanSubdomains('subdomains2', KEY2, batch);
    await rclient.pipelineAndLog(batch);
    expect(await dnsTool.getSubDomains(SUFFIX2)).to.deep.equal([`fresh.${SUFFIX2}`]);
  });

  it('getSubDomains should not refresh TTL', async () => {
    await rclient.zaddAsync(KEY2, Date.now() / 1000, `a.${SUFFIX2}`);
    await rclient.expireAsync(KEY2, 100);
    await dnsTool.getSubDomains(SUFFIX2);
    expect(await rclient.ttlAsync(KEY2)).to.be.within(1, 100);
  });

  it('getSubDomains should not scan rdns when the index is empty', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    const scan = rclient.scanAsync;
    let scans = 0;
    rclient.scanAsync = function() {
      scans++;
      return scan.apply(this, arguments);
    };
    try {
      expect(await dnsTool.getSubDomains(SUFFIX2)).to.be.empty;
    } finally {
      rclient.scanAsync = scan;
    }
    expect(scans).to.equal(0);
    expect(await rclient.typeAsync(KEY2)).to.equal('none');
  });

  it('addSubDomains should create the index', async () => {
    const name = `create-${Date.now()}.${SUFFIX2}`;
    await dnsTool.addSubDomains(SUFFIX2, [name]);
    expect(await dnsTool.getSubDomains(SUFFIX2)).to.deep.equal([name]);
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);
  });

  async function seedRdns(count, scoreOf) {
    const cmds = [];
    for (let i = 0; i < count; i++)
      cmds.push(['zadd', `rdns:domain:r${i}.${SUFFIX2}`, scoreOf(i), '198.18.0.1']);
    for (let i = 0; i < cmds.length; i += 5000)
      await rclient.pipelineAndLog(cmds.slice(i, i + 5000));
  }

  async function seedLegacy(names) {
    for (let i = 0; i < names.length; i += 5000)
      await rclient.saddAsync(LEGACY_KEY2, names.slice(i, i + 5000));
  }

  it('migrateLegacySubDomains should keep names with rdns, scored by last resolve time, and unlink the legacy set', async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedRdns(10, i => now - i);
    const names = [];
    for (let i = 0; i < 20; i++) // r10 ~ r19 have no rdns
      names.push(`r${i}.${SUFFIX2}`);
    await seedLegacy(names);
    // names written after upgrade are kept
    await rclient.zaddAsync(KEY2, now, `written.${SUFFIX2}`);

    await dnsTool.migrateLegacySubDomains();

    expect(await rclient.typeAsync(LEGACY_KEY2)).to.equal('none');
    expect(await rclient.zcardAsync(KEY2)).to.equal(11);
    for (let i = 0; i < 10; i++)
      expect(Number(await rclient.zscoreAsync(KEY2, `r${i}.${SUFFIX2}`))).to.equal(now - i);
    expect(await rclient.zscoreAsync(KEY2, `written.${SUFFIX2}`)).to.not.equal(null);
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);
  });

  it('migrateLegacySubDomains over the limit should keep the most recently resolved names', async () => {
    const limit = 100000;
    const extra = 10;
    const now = Date.now() / 1000;
    // the first `extra` names were resolved earlier than the others
    await seedRdns(limit + extra, i => i < extra ? now - 3600 : now - i / 1000);
    const names = [];
    for (let i = 0; i < limit + extra; i++)
      names.push(`r${i}.${SUFFIX2}`);
    await seedLegacy(names);

    await dnsTool.migrateLegacySubDomains();

    expect(await rclient.zcardAsync(KEY2)).to.equal(limit);
    for (let i = 0; i < extra; i++)
      expect(await rclient.zscoreAsync(KEY2, `r${i}.${SUFFIX2}`)).to.equal(null);
    expect(await rclient.typeAsync(LEGACY_KEY2)).to.equal('none');
  }).timeout(120000);

  it('addSubDomains should set TTL and skip the same name within write interval', async () => {
    const name = `dedup-${Date.now()}.${SUFFIX2}`;
    await dnsTool.addSubDomains(SUFFIX2, [name]);
    expect(Number(await rclient.zscoreAsync(KEY2, name))).to.be.above(0);
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);

    await rclient.zaddAsync(KEY2, 1, name);
    await dnsTool.addSubDomains(SUFFIX2, [name]);
    expect(await rclient.zscoreAsync(KEY2, name)).to.equal('1');
  });

  it('addSubDomains should trim the least recently seen names beyond the limit', async () => {
    const limit = 100000;
    const old = Date.now() / 1000 - 100;
    for (let i = 0; i < limit; i += 1000) {
      const args = [KEY2];
      for (let j = i; j < i + 1000; j++)
        args.push(old, `seed${j}.${SUFFIX2}`);
      await rclient.zaddAsync(args);
    }
    const added = [];
    for (let i = 0; i < 5; i++)
      added.push(`new${i}-${Date.now()}.${SUFFIX2}`);
    await dnsTool.addSubDomains(SUFFIX2, added);

    expect(await rclient.zcardAsync(KEY2)).to.equal(limit);
    for (const name of added)
      expect(await rclient.zscoreAsync(KEY2, name)).to.not.equal(null);
  });

  it('concurrent addSubDomains on a full index should trim only the excess', async () => {
    const limit = 100000;
    const old = Date.now() / 1000 - 100;
    for (let i = 0; i < limit; i += 1000) {
      const args = [KEY2];
      for (let j = i; j < i + 1000; j++)
        args.push(old, `seed${j}.${SUFFIX2}`);
      await rclient.zaddAsync(args);
    }
    // both writes see a count over the limit before either trims, a trim computed from that count
    // would remove one name too many
    const names = [`c1-${Date.now()}.${SUFFIX2}`, `c2-${Date.now()}.${SUFFIX2}`];
    await Promise.all(names.map(n => dnsTool.addSubDomains(SUFFIX2, [n])));
    expect(await rclient.zcardAsync(KEY2)).to.equal(limit);
    for (const name of names)
      expect(await rclient.zscoreAsync(KEY2, name)).to.not.equal(null);
  });

  it('trim with a stale count should not remove names once the index is below the limit', async () => {
    // e.g. retention cleanup ran between the write that returned the count and the trim
    const now = Date.now() / 1000;
    await rclient.zaddAsync(KEY2, now - 1, `a.${SUFFIX2}`, now, `b.${SUFFIX2}`);
    await dnsTool._trimSubDomains(SUFFIX2, 100000 + 5);
    expect(await rclient.zcardAsync(KEY2)).to.equal(2);
  });
});
