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

// a subdomains:<suffix> set larger than the max number of function arguments (~125k on node 12)
// used to crash category ipset recycle with "RangeError: Maximum call stack size exceeded"
const SUFFIX = 'fwtest-pattern-expansion.com';
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
    await rclient.unlinkAsync(`subdomains:${SUFFIX}`, `srdns:pattern:${SUFFIX}`);

    const names = [];
    for (let i = 0; i < SUBDOMAIN_COUNT; i++)
      names.push(`n${i}.${SUFFIX}`);
    for (let i = 0; i < names.length; i += 1000)
      await rclient.saddAsync(`subdomains:${SUFFIX}`, names.slice(i, i + 1000));

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
    await rclient.unlinkAsync(`subdomains:${SUFFIX}`, `srdns:pattern:${SUFFIX}`);
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

  it('unionDomainMappings should leave no key when no mapping exists', async () => {
    const dest = `srdns:pattern:${SUFFIX}`;
    await categoryUpdater.unionDomainMappings(dest, [`rdns:domain:none1.${SUFFIX}`, `rdns:domain:none2.${SUFFIX}`]);
    expect(await rclient.typeAsync(dest)).to.equal('none');
  });
});
