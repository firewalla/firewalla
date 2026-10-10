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
    // mark the seeded index as built (SUBDOMAIN_BUILT_MARKER in net2/DNSTool.js), so it is read as is
    // instead of being rebuilt from rdns and trimmed to the size limit
    await rclient.zaddAsync(SUBDOMAIN_KEY, '+inf', '#built');

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

  it('getIPsByDomainMappings should return complete IPs under concurrent calls on the same pattern', async () => {
    const mappings = await categoryUpdater.getDomainMappingsByDomainPattern(`*.${SUFFIX}`);
    const expected = Array.from(expectedIPs).sort();
    // categories sharing a pattern are recycled concurrently, a shared dest key used to yield partial results
    // starts are staggered, calls started in the same tick run their chunks in lockstep and would hide the race
    const results = await Promise.all([0, 1, 2].map(k => new Promise(resolve => setTimeout(resolve, k * 20))
      .then(() => categoryUpdater.getIPsByDomainMappings(`*.${SUFFIX}`, mappings))));
    for (const ips of results)
      expect(ips.slice().sort()).to.deep.equal(expected);
    expect(await rclient.scanResults(`srdns:pattern:${SUFFIX}:*`)).to.be.empty;
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
  // SUBDOMAIN_BUILT_MARKER in net2/DNSTool.js, marks the index as fully built from rdns
  const MARKER = '#built';

  beforeEach(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX2}`);
    await rclient.unlinkAsync(KEY2);
  });

  after(async () => {
    await unlinkByPattern(`rdns:domain:*${SUFFIX2}`);
    await rclient.unlinkAsync(KEY2);
  });

  it('getSubDomains should drop names not seen in 24 hours', async () => {
    const now = Date.now() / 1000;
    await rclient.zaddAsync(KEY2, now - 2 * 86400, `old.${SUFFIX2}`, now, `fresh.${SUFFIX2}`, '+inf', MARKER);
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains).to.deep.equal([`fresh.${SUFFIX2}`]);
    expect(await rclient.zscoreAsync(KEY2, `old.${SUFFIX2}`)).to.equal(null);
  });

  it('getSubDomains should not refresh TTL', async () => {
    await rclient.zaddAsync(KEY2, Date.now() / 1000, `a.${SUFFIX2}`, '+inf', MARKER);
    await rclient.expireAsync(KEY2, 100);
    await dnsTool.getSubDomains(SUFFIX2);
    expect(await rclient.ttlAsync(KEY2)).to.be.within(1, 100);
  });

  it('getSubDomains should rebuild from rdns when empty', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    await rclient.zaddAsync(`rdns:domain:b.${SUFFIX2}`, Date.now() / 1000, '198.18.0.2');
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains.slice().sort()).to.deep.equal([`a.${SUFFIX2}`, `b.${SUFFIX2}`, SUFFIX2].sort());
    expect(await rclient.zcardAsync(KEY2)).to.equal(4);
    expect(await rclient.zscoreAsync(KEY2, MARKER)).to.equal('inf');
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);
  });

  it('getSubDomains should rebuild when only the marker is left', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    // all names aged out, e.g. no category had the pattern registered for a day, while rdns kept recording
    await rclient.zaddAsync(KEY2, '+inf', MARKER, Date.now() / 1000 - 2 * 86400, `old.${SUFFIX2}`);
    await rclient.expireAsync(KEY2, 3600);
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains.slice().sort()).to.deep.equal([`a.${SUFFIX2}`, SUFFIX2].sort());
  });

  it('rebuild merge should always leave the key with TTL', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    // an existing index without TTL and without marker, ZUNIONSTORE would drop any TTL of the destination
    await rclient.zaddAsync(KEY2, Date.now() / 1000, `b.${SUFFIX2}`);
    await rclient.persistAsync(KEY2);
    await dnsTool.getSubDomains(SUFFIX2);
    expect(await rclient.ttlAsync(KEY2)).to.be.above(86400);
    expect(await rclient.zscoreAsync(KEY2, MARKER)).to.equal('inf');
  });

  it('getSubDomains should still rebuild when addSubDomains created the key first', async () => {
    await rclient.zaddAsync(`rdns:domain:a.${SUFFIX2}`, Date.now() / 1000, '198.18.0.1');
    const early = `early-${Date.now()}.${SUFFIX2}`;
    // a writer may create the key with a single name before the index is ever built
    await dnsTool.addSubDomains(SUFFIX2, [early]);
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    expect(domains.slice().sort()).to.deep.equal([`a.${SUFFIX2}`, early, SUFFIX2].sort());
  });

  async function seedRdns(count) {
    const names = [];
    const cmds = [];
    for (let i = 0; i < count; i++) {
      const name = `r${i}.${SUFFIX2}`;
      names.push(name);
      cmds.push(['zadd', `rdns:domain:${name}`, Date.now() / 1000, `198.18.${Math.floor(i / 256) % 256}.${i % 256}`]);
    }
    for (let i = 0; i < cmds.length; i += 1000)
      await rclient.pipelineAndLog(cmds.slice(i, i + 1000));
    return names.concat([SUFFIX2]).sort();
  }

  it('rebuild should never expose a partial index to readers', async () => {
    const expected = await seedRdns(5000);
    // poll the published key while it is being rebuilt, as a reader in another process would
    let done = false;
    const observed = [];
    const poll = (async () => {
      while (!done) {
        observed.push(await rclient.zcardAsync(KEY2));
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    const domains = await dnsTool.getSubDomains(SUFFIX2);
    done = true;
    await poll;
    expect(domains.slice().sort()).to.deep.equal(expected);
    // the published key is either not built yet or complete (names + marker)
    expect(observed.filter(n => n !== 0 && n !== expected.length + 1)).to.be.empty;
  });

  it('rebuild should keep names added concurrently by addSubDomains', async () => {
    const expected = await seedRdns(3000);
    const added = `added-${Date.now()}.${SUFFIX2}`;
    const rebuild = dnsTool.getSubDomains(SUFFIX2);
    await dnsTool.addSubDomains(SUFFIX2, [added]);
    await rebuild;
    const members = await rclient.zrangeAsync(KEY2, 0, -1);
    expect(members.slice().sort()).to.deep.equal(expected.concat([added, MARKER]).sort());
  });

  it('concurrent getSubDomains should share one rebuild and leave no temp key', async () => {
    const expected = await seedRdns(3000);
    const results = await Promise.all([0, 1, 2].map(k => new Promise(resolve => setTimeout(resolve, k * 5))
      .then(() => dnsTool.getSubDomains(SUFFIX2))));
    for (const domains of results)
      expect(domains.slice().sort()).to.deep.equal(expected);
    expect(await rclient.scanResults(`subdomains2_rebuild:${SUFFIX2}:*`)).to.be.empty;
  });

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
});
