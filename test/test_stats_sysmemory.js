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
// Mirrors child_process.execFile: a function in the args position is taken as the callback.
function execFile(file, args, cb) {
  if (typeof args === 'function') {
    cb = args;
    args = [];
  }
  calls.push({ file, args });
  setImmediate(() => cb(null, FREE_OUTPUT, ''));
}

const stat = proxyquire('../util/Stats.js', { child_process: { execFile } });

describe('Stats.sysmemory', () => {
  beforeEach(() => {
    calls.length = 0;
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
});
