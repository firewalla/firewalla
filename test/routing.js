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

const chai = require('chai');
const expect = chai.expect;
const fs = require('fs');
const cp = require('child_process');

const routing = require('../extension/routing/routing.js');
const loggerManager = require('../net2/LoggerManager.js');

const RT_TABLES = '/etc/iproute2/rt_tables';
const REG_NAME = `zz_test_rt_${process.pid}`;
const VC_NAME = `zz_test_vc_${process.pid}`;

// --- helpers that read the system, never a function return value -------------

function run(cmd, args) {
  return cp.spawnSync(cmd, args, { encoding: 'utf8' });
}

// the whole point of an rt_tables entry is that iproute2 resolves the name. an unknown name
// makes "ip route show table" exit 255 with "table id value is invalid"
function ipResolvesTable(name) {
  return run('ip', ['route', 'show', 'table', name]).status === 0;
}

// the id as recorded in rt_tables, parsed independently of what the function returned
function idInTables(name) {
  const row = run('sudo', ['cat', RT_TABLES]).stdout.split('\n')
    .find(l => l.split(/\s+/)[1] === name);
  if (!row) return undefined;
  return Number(row.split(/\s+/)[0]);
}

function rowInTables(name) {
  return run('sudo', ['cat', RT_TABLES]).stdout.split('\n')
    .find(l => l.split(/\s+/)[1] === name);
}

function blankLineCount() {
  return run('sudo', ['cat', RT_TABLES]).stdout.split('\n').filter(l => l === '').length;
}

// these tests need sudo and /etc/iproute2/rt_tables, so they only run on a box
function boxOnly(ctx) {
  if (run('sudo', ['cat', RT_TABLES]).status === 0) return true;
  ctx.skip();
  return false;
}

// --- the validator on its own, no box needed --------------------------------

describe('Test isValidTableName', function() {
  const rejected = [
    ['a command substitution', 'x$(id)y'],
    ['a backtick', 'x`id`y'],
    ['a semicolon', 'x;id'],
    ['a pipe', 'x|id'],
    ['an ampersand', 'x&id'],
    ['a space', 'a b'],
    ['a tab', 'a\tb'],
    ['a newline', 'a\nb'],
    ['a double quote', 'a"b'],
    ['a single quote', "a'b"],
    ['a slash', 'a/b'],
    ['a redirection', 'a>b'],
    ['the empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345],
    ['an object', {}],
  ];
  for (const [label, name] of rejected) {
    it(`should reject ${label}`, function() {
      expect(routing.isValidTableName(name)).to.be.false;
    });
  }

  // ':' and '@' are the two characters an interface name may carry beyond a plain word, so a table
  // name built from one has to pass
  const accepted = ['main', 'x', 'wan_eth0', 'vpn_0a03_D957F', 'a.b-c_d', 'A1', 'a'.repeat(200),
                    'eth0:1_local', 'eth0@if5_default'];
  for (const name of accepted) {
    it(`should accept ${JSON.stringify(name.length > 20 ? name.slice(0, 12) + '...' : name)}`, function() {
      expect(routing.isValidTableName(name)).to.be.true;
    });
  }
});

// --- the guard is actually wired into both entry points ---------------------

describe('Test routing table name guard', function() {
  this.timeout(30000);

  // the guard logs before it throws; keep that out of the run output so a pass does not read
  // like a failure. Routing is the name logger.js derives from routing.js
  let prevLevel;
  before(function() {
    prevLevel = loggerManager.loggers['Routing'] && loggerManager.loggers['Routing'].effectiveLogLevel;
    loggerManager.setLogLevel('Routing', 'none');
  });
  after(function() {
    loggerManager.setLogLevel('Routing', prevLevel);
  });

  const bad = 'x$(id)y';

  it('should throw from createCustomizedRoutingTable', async function() {
    let err = null;
    try { await routing.createCustomizedRoutingTable(bad); } catch (e) { err = e; }
    expect(err).to.not.be.null;
    expect(String(err.message)).to.match(/Invalid routing table name/);
  });

  it('should throw from removeCustomizedRoutingTable', async function() {
    let err = null;
    try { await routing.removeCustomizedRoutingTable(bad); } catch (e) { err = e; }
    expect(err).to.not.be.null;
    expect(String(err.message)).to.match(/Invalid routing table name/);
  });

  it('should write nothing to rt_tables for a rejected name', async function() {
    if (!boxOnly(this)) return;
    const before = run('sudo', ['cat', RT_TABLES]).stdout;
    try { await routing.createCustomizedRoutingTable(bad); } catch (e) {}
    try { await routing.removeCustomizedRoutingTable(bad); } catch (e) {}
    expect(run('sudo', ['cat', RT_TABLES]).stdout).to.equal(before);
  });

  it('should not run a command substitution in a rejected name', async function() {
    if (!boxOnly(this)) return;
    const marker = `/tmp/zz_rt_marker_${process.pid}`;
    try { await routing.createCustomizedRoutingTable(`x$(touch ${marker})y`); } catch (e) {}
    try { await routing.removeCustomizedRoutingTable(`x$(touch ${marker})y`); } catch (e) {}
    expect(fs.existsSync(marker)).to.be.false;
  });
});

// --- lifecycle, asserted against rt_tables and against iproute2 -------------

describe('Test customized routing table lifecycle', function() {
  this.timeout(30000);

  after(async function() {
    for (const name of [REG_NAME, VC_NAME, `${REG_NAME}_del`, `${REG_NAME}_noshell`,
                        `${REG_NAME}.100_x`, `${REG_NAME}X100_x`]) {
      run('sudo', ['ip', 'route', 'flush', 'table', name]);
      try { await routing.removeCustomizedRoutingTable(name); } catch (e) {}
    }
  });

  it('should make iproute2 resolve a name that did not exist before', async function() {
    if (!boxOnly(this)) return;
    expect(ipResolvesTable(REG_NAME)).to.be.false;

    const returned = await routing.createCustomizedRoutingTable(REG_NAME);

    // the system, not the return value, is the source of truth
    expect(ipResolvesTable(REG_NAME)).to.be.true;
    const id = idInTables(REG_NAME);
    expect(id).to.be.a('number');
    expect(Number.isNaN(id)).to.be.false;
    expect(id).to.be.above(0);
    // and only then confirm the function reported what the system actually has
    expect(returned).to.equal(id);
  });

  it('should write exactly one tab separated row, with no stray -e', async function() {
    if (!boxOnly(this)) return;
    const row = rowInTables(REG_NAME);
    expect(row).to.be.a('string');
    expect(row.split('\t')).to.have.lengthOf(2);
    expect(row).to.not.include('-e');
    expect(row).to.equal(`${idInTables(REG_NAME)}\t${REG_NAME}`);
    const rows = run('sudo', ['cat', RT_TABLES]).stdout.split('\n')
      .filter(l => l.split(/\s+/)[1] === REG_NAME);
    expect(rows).to.have.lengthOf(1);
  });

  // proves the name really maps to that id in the kernel, not just in the text file
  it('should route by name and by id to the same table', async function() {
    if (!boxOnly(this)) return;
    const id = idInTables(REG_NAME);
    expect(run('sudo', ['ip', 'route', 'add', 'unreachable', 'default', 'table', REG_NAME]).status).to.equal(0);
    try {
      const byName = run('ip', ['route', 'show', 'table', REG_NAME]);
      const byId = run('ip', ['route', 'show', 'table', String(id)]);
      expect(byName.status).to.equal(0);
      expect(byId.status).to.equal(0);
      expect(byName.stdout.trim()).to.equal('unreachable default');
      expect(byId.stdout).to.equal(byName.stdout);
    } finally {
      run('sudo', ['ip', 'route', 'flush', 'table', REG_NAME]);
    }
  });

  it('should keep working when SHELL is not set in the environment', async function() {
    if (!boxOnly(this)) return;
    const name = `${REG_NAME}_noshell`;
    const saved = process.env.SHELL;
    delete process.env.SHELL;
    try {
      await routing.createCustomizedRoutingTable(name);
      expect(ipResolvesTable(name)).to.be.true;
      expect(rowInTables(name)).to.equal(`${idInTables(name)}\t${name}`);
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
    await routing.removeCustomizedRoutingTable(name);
    expect(ipResolvesTable(name)).to.be.false;
  });

  it('should not add a second row when the table already exists', async function() {
    if (!boxOnly(this)) return;
    const idBefore = idInTables(REG_NAME);
    const returned = await routing.createCustomizedRoutingTable(REG_NAME);
    expect(idInTables(REG_NAME)).to.equal(idBefore);
    expect(returned).to.equal(idBefore);
    const rows = run('sudo', ['cat', RT_TABLES]).stdout.split('\n')
      .filter(l => l.split(/\s+/)[1] === REG_NAME);
    expect(rows).to.have.lengthOf(1);
  });

  it('should place a vpn client table id above the bit offset', async function() {
    if (!boxOnly(this)) return;
    await routing.createCustomizedRoutingTable(VC_NAME, routing.RT_TYPE_VC);
    expect(ipResolvesTable(VC_NAME)).to.be.true;
    // read the id out of rt_tables and check the RT_TYPE_VC shift there
    const id = idInTables(VC_NAME);
    expect(id >>> 10).to.be.above(0);
    expect(id >>> 10).to.be.below(64);
    expect(rowInTables(VC_NAME)).to.equal(`${id}\t${VC_NAME}`);
  });

  it('should delete the row on remove rather than blanking it', async function() {
    if (!boxOnly(this)) return;
    const name = `${REG_NAME}_del`;
    await routing.createCustomizedRoutingTable(name);
    expect(ipResolvesTable(name)).to.be.true;
    const blanksBefore = blankLineCount();

    await routing.removeCustomizedRoutingTable(name);

    expect(ipResolvesTable(name)).to.be.false;
    expect(rowInTables(name)).to.be.undefined;
    // sed 's///' would have left an empty line behind
    expect(blankLineCount()).to.equal(blanksBefore);
  });

  it('should leave rt_tables untouched when removing a table that is not there', async function() {
    if (!boxOnly(this)) return;
    const before = run('sudo', ['cat', RT_TABLES]).stdout;
    await routing.removeCustomizedRoutingTable(`${REG_NAME}_absent`);
    expect(run('sudo', ['cat', RT_TABLES]).stdout).to.equal(before);
  });

  // the name goes into a sed address, so an unescaped '.' would match any character there and take
  // a sibling row with it. VLAN table names carry a dot, so this is a shape that really occurs
  it('should not let a dot in the name match a neighbouring row', async function() {
    if (!boxOnly(this)) return;
    const dotted = `${REG_NAME}.100_x`;
    const sibling = `${REG_NAME}X100_x`;
    await routing.createCustomizedRoutingTable(dotted);
    await routing.createCustomizedRoutingTable(sibling);

    await routing.removeCustomizedRoutingTable(dotted);

    expect(rowInTables(dotted)).to.be.undefined;
    expect(rowInTables(sibling)).to.not.be.undefined;
  });
});
