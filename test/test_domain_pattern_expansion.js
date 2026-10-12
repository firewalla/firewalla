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

  beforeEach(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX2}`);
    await rclient.unlinkAsync(KEY2);
  });

  after(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX2}`);
    await unlinkByPattern(`subdomains2_rebuild:${SUFFIX2}:*`);
    await rclient.unlinkAsync(KEY2);
  });

  it('getSubDomains should drop names not seen in 24 hours', async () => {
    const now = Date.now() / 1000;
    await rclient.zaddAsync(KEY2, now - 2 * 86400, `old.${SUFFIX2}`, now, `fresh.${SUFFIX2}`);
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains).to.deep.equal([`fresh.${SUFFIX2}`]);
    expect(await rclient.zscoreAsync(KEY2, `old.${SUFFIX2}`)).to.equal(null);
  });

  it('getSubDomains should not refresh TTL', async () => {
    await rclient.zaddAsync(KEY2, Date.now() / 1000, `a.${SUFFIX2}`);
    await rclient.expireAsync(KEY2, 100);
    await dnsTool.getSubDomains(SUFFIX2);
    expect(await rclient.ttlAsync(KEY2)).to.be.within(1, 100);
  });

  it('getSubDomains should rebuild from rdns when empty', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    await rclient.zaddAsync(`rdns:domain:b.${SUFFIX2}`, Date.now() / 1000, '198.18.0.2');
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains.slice().sort()).to.deep.equal([`a.${SUFFIX2}`, `b.${SUFFIX2}`, SUFFIX2].sort());
    expect(await rclient.zcardAsync(KEY2)).to.equal(3);
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);
  });

  it('getSubDomains should never return or expose a partially rebuilt index', async () => {
    const count = 20000;
    const now = Date.now() / 1000;
    const cmds = [];
    for (let i = 0; i < count; i++)
      cmds.push(['zadd', `rdns:domain:r${i}.${SUFFIX2}`, now, '198.18.0.1']);
    for (let i = 0; i < cmds.length; i += 1000)
      await rclient.pipelineAndLog(cmds.slice(i, i + 1000));

    let done = false;
    const rebuild = dnsTool.getSubDomains(SUFFIX2).then((domains) => { done = true; return domains; });
    // poll the index while the rebuild is in progress, it must be either absent or complete.
    // a reader started on an absent index rebuilds by itself, so only read once the index shows up
    const sizes = [];
    let read = null;
    while (!done) {
      const size = await rclient.zcardAsync(KEY2);
      sizes.push(size);
      if (size > 0 && !read)
        read = await dnsTool.getSubDomains(SUFFIX2);
    }
    expect((await rebuild).length).to.equal(count + 1);
    for (const size of sizes)
      expect([0, count + 1]).to.include(size);
    if (read)
      expect(read.length).to.equal(count + 1);
  });

  async function seedRdns(count, scoreOf) {
    const cmds = [];
    for (let i = 0; i < count; i++)
      cmds.push(['zadd', `rdns:domain:r${i}.${SUFFIX2}`, scoreOf(i), '198.18.0.1']);
    for (let i = 0; i < cmds.length; i += 5000)
      await rclient.pipelineAndLog(cmds.slice(i, i + 5000));
  }

  it('rebuild temp key should never exist without TTL', async () => {
    await seedRdns(20000, () => Date.now() / 1000);
    let done = false;
    const rebuild = dnsTool.getSubDomains(SUFFIX2).then(() => { done = true; });
    const ttls = [];
    while (!done) {
      for (const k of await rclient.scanResults(`subdomains2_rebuild:${SUFFIX2}:*`))
        ttls.push(await rclient.ttlAsync(k));
    }
    await rebuild;
    expect(ttls).to.not.include(-1);
  });

  it('concurrent rebuilds in one process should share one run, publish one complete index and leave no temp key', async () => {
    const count = 20000;
    await seedRdns(count, () => Date.now() / 1000);
    const doRebuild = dnsTool._doRebuildSubDomains;
    let runs = 0;
    dnsTool._doRebuildSubDomains = function(suffix) {
      runs++;
      return doRebuild.call(this, suffix);
    };
    let results;
    try {
      results = await Promise.all([0, 1, 2].map(() => dnsTool.getSubDomains(SUFFIX2)));
    } finally {
      dnsTool._doRebuildSubDomains = doRebuild;
    }
    expect(runs).to.equal(1);
    expect(dnsTool.subDomainRebuilds.size).to.equal(0);
    for (const domains of results)
      expect(domains.length).to.equal(count + 1);
    // each caller gets its own copy
    results[0].pop();
    expect(results[1].length).to.equal(count + 1);
    expect(await rclient.zcardAsync(KEY2)).to.equal(count + 1);
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);
    expect(await rclient.scanResults(`subdomains2_rebuild:${SUFFIX2}:*`)).to.be.empty;
  });

  it('rebuild should not overwrite an index published in the meantime', async () => {
    await seedRdns(10, () => Date.now() / 1000);
    // another rebuild has published, and addSubDomains has added a name since then
    await rclient.zaddAsync(KEY2, Date.now() / 1000, `written.${SUFFIX2}`);
    const domains = await dnsTool._rebuildSubDomains(SUFFIX2);
    expect(domains.length).to.equal(11);
    expect(await rclient.zrangeAsync(KEY2, 0, -1)).to.deep.equal([`written.${SUFFIX2}`]);
    expect(await rclient.scanResults(`subdomains2_rebuild:${SUFFIX2}:*`)).to.be.empty;
  });

  it('rebuild over the limit should keep the most recently resolved names and the suffix itself', async () => {
    const limit = 100000;
    const extra = 10;
    const now = Date.now() / 1000;
    // the first `extra` names were resolved earlier than the others
    await seedRdns(limit + extra, i => i < extra ? now - 3600 : now - i / 1000);
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains.length).to.equal(limit);
    expect(await rclient.zcardAsync(KEY2)).to.equal(limit);
    expect(await rclient.zscoreAsync(KEY2, SUFFIX2)).to.not.equal(null);
    for (let i = 0; i < extra; i++)
      expect(await rclient.zscoreAsync(KEY2, `r${i}.${SUFFIX2}`)).to.equal(null);
    // kept names carry their last resolve time, so later trims and retention follow it
    expect(Number(await rclient.zscoreAsync(KEY2, `r${extra}.${SUFFIX2}`))).to.be.closeTo(now - extra / 1000, 0.01);
  }).timeout(120000);

  it('addSubDomains should not create the index, so an empty index is still rebuilt from rdns', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    await rclient.zaddAsync(`rdns:domain:b.${SUFFIX2}`, Date.now() / 1000, '198.18.0.2');
    const name = `skip-${Date.now()}.${SUFFIX2}`;
    await dnsTool.addSubDomains(SUFFIX2, [name]);
    expect(await rclient.typeAsync(KEY2)).to.equal('none');

    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains.slice().sort()).to.deep.equal([`a.${SUFFIX2}`, `b.${SUFFIX2}`, SUFFIX2].sort());
    // a skipped write is not cached, the same name is written as soon as the index exists
    await dnsTool.addSubDomains(SUFFIX2, [name]);
    expect(await rclient.zscoreAsync(KEY2, name)).to.not.equal(null);
  });

  it('addSubDomains should set TTL and skip the same name within write interval', async () => {
    const name = `dedup-${Date.now()}.${SUFFIX2}`;
    await rclient.zaddAsync(KEY2, Date.now() / 1000, SUFFIX2); // index exists, without TTL
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
