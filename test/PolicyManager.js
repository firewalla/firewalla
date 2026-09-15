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

const chai = require('chai');
const expect = chai.expect;

const policyManager = require('../net2/PolicyManager.js');
const loggerManager = require('../net2/LoggerManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

// stands in for a monitorable (Host, NetworkProfile, Tag, Identity) and records which policies were
// actually applied, so a skipped one can be told apart from an applied one
function stubMonitorable(applied) {
  return {
    oper: {},
    constructor: { name: 'Host', getClassName: () => 'Host' },
    getReadableName: () => 'test target',
    getUniqueId: () => 'AA:BB:CC:DD:EE:FF',
    spoof: async (v) => { applied.push(['spoof', v]) },
    qos: async (v) => { applied.push(['qos', v]) },
    acl: async (v) => { applied.push(['acl', v]) },
    aclTimer: async (v) => { applied.push(['aclTimer', v]) },
    shield: async (v) => { applied.push(['shield', v]) },
    app: async (v) => { applied.push(['app', v]) },
    ipAllocation: async (v) => { applied.push(['ipAllocation', v]) },
    vpnClient: async (v) => { applied.push(['vpnClient', v]) },
    tags: async (v, type) => { applied.push(['tags', v, type]) },
    _dnsmasq: async (v) => { applied.push(['_dnsmasq', v]) },
  };
}

const keysOf = (applied) => applied.map(a => a[0]);

// a policy value can reach a dnsmasq config file, the ipset restore stream or an iptables command
// line, all of them line oriented, so execute() drops just the offending key and applies the rest
describe('Test PolicyManager policy value validation', function() {
  this.timeout(10000);

  // execute() logs an error for every policy it refuses; keep that out of the run output so a
  // passing run does not read like a failing one. the vpnClient and tags paths also emit OSI
  // events, so stub the sender rather than publishing to a live FireMain
  let prevLevel, origSend;
  before(function() {
    prevLevel = loggerManager.loggers['PolicyManager'] && loggerManager.loggers['PolicyManager'].effectiveLogLevel;
    loggerManager.setLogLevel('PolicyManager', 'none');
    origSend = sem.sendEventToFireMain;
    sem.sendEventToFireMain = () => {};
  });
  after(function() {
    loggerManager.setLogLevel('PolicyManager', prevLevel);
    sem.sendEventToFireMain = origSend;
  });

  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const NUL = String.fromCharCode(0);
  const DEL = String.fromCharCode(127);

  // the load-bearing half of "skip": oper must stay unset, or the bad value would count as
  // already-applied next round and never be retried
  it('should not record oper for a skipped policy', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', { acl: 'bad' + NL + 'server-high=/evil.com/1.2.3.4', qos: false });
    expect(keysOf(applied)).to.not.include('acl');
    expect(target.oper).to.not.have.property('acl');
    expect(target.oper.qos).to.be.false;
  });

  it('should retry a previously skipped policy once its value is clean', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', { acl: 'bad' + NL + 'x' });
    applied.length = 0;
    await policyManager.execute(target, '1.2.3.4', { acl: true });
    expect(applied.filter(a => a[0] === 'acl')).to.deep.equal([['acl', true]]);
  });

  for (const [label, ch] of [['a line break', NL], ['a carriage return', CR], ['a NUL', NUL], ['a DEL', DEL]]) {
    it(`should skip a policy whose value holds ${label}`, async function() {
      const applied = [];
      const target = stubMonitorable(applied);
      await policyManager.execute(target, '1.2.3.4', { acl: 'a' + ch + 'b', qos: false });
      expect(keysOf(applied)).to.not.include('acl');
      expect(target.oper).to.not.have.property('acl');
      expect(keysOf(applied)).to.include('qos');
    });
  }

  it('should catch a control character nested in an object value', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', {
      vpnClient: { state: true, profileId: 'a' + NL + 'b' }, qos: false,
    });
    expect(keysOf(applied)).to.not.include('vpnClient');
    expect(target.oper).to.not.have.property('vpnClient');
    expect(keysOf(applied)).to.include('qos');
  });

  it('should catch a control character nested inside an array', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', { tags: ['ok', 'bad' + NL + 'x'], qos: false });
    expect(keysOf(applied)).to.not.include('tags');
    expect(target.oper).to.not.have.property('tags');
    expect(keysOf(applied)).to.include('qos');
  });

  it('should catch a control character several levels deep', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', {
      aclTimer: { schedule: { windows: [{ from: 'a' + NL + 'b' }] } }, qos: false,
    });
    expect(keysOf(applied)).to.not.include('aclTimer');
    expect(keysOf(applied)).to.include('qos');
  });

  it('should skip a policy whose value defines toJSON', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', {
      acl: { toJSON: () => ({ state: true }) }, qos: false,
    });
    expect(keysOf(applied)).to.not.include('acl');
    expect(target.oper).to.not.have.property('acl');
    expect(keysOf(applied)).to.include('qos');
  });

  it('should skip every offending policy and apply every clean one', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', {
      acl: 'a' + NL + 'b',
      shield: 'c' + NUL + 'd',
      qos: false,
      app: { name: 'clean' },
      monitor: true,
    });
    const keys = keysOf(applied);
    expect(keys).to.not.include('acl');
    expect(keys).to.not.include('shield');
    expect(keys).to.include('qos');
    expect(keys).to.include('app');
    expect(target.oper).to.not.have.property('acl');
    expect(target.oper).to.not.have.property('shield');
  });

  // dnsmasq is applied after the main loop and re-checks invalidPolicyKeys on its own
  it('should not apply dnsmasq when its own value is invalid', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', {
      dnsmasq: { entries: ['bad' + NL + 'log-queries'] }, qos: false, monitor: true,
    });
    expect(keysOf(applied)).to.not.include('_dnsmasq');
    expect(target.oper).to.not.have.property('dnsmasq');
    expect(keysOf(applied)).to.include('qos');
  });

  it('should still apply dnsmasq when a different policy is the invalid one', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', {
      dnsmasq: { entries: ['clean'] }, acl: 'a' + NL + 'b', monitor: true,
    });
    expect(keysOf(applied)).to.include('_dnsmasq');
    expect(target.oper.dnsmasq).to.deep.equal({ entries: ['clean'] });
    expect(target.oper).to.not.have.property('acl');
  });

  it('should keep the prioritized order among the surviving policies', async function() {
    const applied = [];
    await policyManager.execute(stubMonitorable(applied), '1.2.3.4', {
      qos: true, acl: false, tags: ['t1'], vpnClient: { state: false }, shield: 'a' + NL + 'b',
    });
    const keys = keysOf(applied);
    expect(keys).to.not.include('shield');
    expect(keys.indexOf('vpnClient')).to.be.below(keys.indexOf('tags'));
    expect(keys.indexOf('tags')).to.be.below(keys.indexOf('acl'));
    expect(keys.indexOf('acl')).to.be.below(keys.indexOf('qos'));
  });

  // an invalid monitor is skipped, and because policy.monitor is set the default-monitor fallback
  // does not fire either, so the target keeps whatever spoof state it already had
  it('should leave spoof untouched when monitor itself is invalid', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', { monitor: 'a' + NL + 'b' });
    expect(keysOf(applied)).to.not.include('spoof');
    expect(target.oper).to.not.have.property('monitor');
  });

  it('should apply a clean policy untouched', async function() {
    const applied = [];
    const target = stubMonitorable(applied);
    await policyManager.execute(target, '1.2.3.4', { acl: true, qos: false });
    expect(keysOf(applied)).to.include('acl');
    expect(keysOf(applied)).to.include('qos');
    expect(target.oper.acl).to.be.true;
  });
});
