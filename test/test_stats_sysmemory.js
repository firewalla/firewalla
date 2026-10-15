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

const chai = require('chai');
const expect = chai.expect;
const util = require('util');
const proxyquire = require('proxyquire').noCallThru();

const FREE_OUTPUT = [
  '              total        used        free      shared  buff/cache   available',
  'Mem:        3884096     1003352      812004       25640     2068740     2594440',
  'Swap:        524284           0      524284',
  ''
].join('\n');

const calls = [];
let output = FREE_OUTPUT;
// Mirrors child_process.execFile: a function in the args position is taken as the callback.
function execFile(file, args, cb) {
  if (typeof args === 'function') {
    cb = args;
    args = [];
  }
  calls.push({ file, args });
  setImmediate(() => cb(null, output, ''));
}

const stat = proxyquire('../util/Stats.js', { child_process: { execFile } });

describe('Stats.sysmemory', () => {
  beforeEach(() => {
    calls.length = 0;
    output = FREE_OUTPUT;
  });

  it('parses free output when promisified and called without args', async () => {
    const memory = await util.promisify(stat.sysmemory)();

    expect(memory).to.be.an('object');
    expect(memory.mem.total).to.equal(3884096);
    expect(memory.mem.free).to.equal(812004);
    expect(memory.swap).to.eql({ total: 524284, used: 0, free: 524284 });
    expect(calls).to.eql([{ file: 'free', args: [] }]);
  });

  it('still passes explicit args to free', async () => {
    const memory = await util.promisify(stat.sysmemory)(['-b']);

    expect(memory.mem.total).to.equal(3884096);
    expect(calls).to.eql([{ file: 'free', args: ['-b'] }]);
  });

  it('reads buff/cache and available from the current free layout', async () => {
    const memory = await util.promisify(stat.sysmemory)();

    expect(memory.mem.cached).to.equal(2068740);
    expect(memory.mem.usable).to.equal(2594440);
    expect(memory.mem.usable).to.be.at.most(memory.mem.total);
    expect(memory.buffer.used).to.be.at.least(0);
    expect(memory.buffer).to.eql({ used: 3884096 - 2594440, free: 2594440 });
  });

  it('keeps free + buffers + cached for the old free layout', async () => {
    output = [
      '             total       used       free     shared    buffers     cached',
      'Mem:       3884096    3072092     812004      25640     102400    1966340',
      '-/+ buffers/cache:    1003352    2880744',
      'Swap:       524284          0     524284',
      ''
    ].join('\n');
    const memory = await util.promisify(stat.sysmemory)();

    expect(memory.mem.buffers).to.equal(102400);
    expect(memory.mem.cached).to.equal(1966340);
    expect(memory.mem.usable).to.equal(812004 + 102400 + 1966340);
    expect(memory.buffer).to.eql({ used: 1003352, free: 2880744 });
  });
});
