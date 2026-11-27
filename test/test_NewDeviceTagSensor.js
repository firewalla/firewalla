/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    ;This program is free software: you can redistribute it and/or  modify
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




const { expect, assert } = require('chai');
const { set } = require('lodash');
let mock;
let sensorInstance;
let cacheSnapshot;

function setupMocks() {
  mock = require('mock-require');
  cacheSnapshot = new Set(Object.keys(require.cache));
  mock('../net2/logger.js', () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  }));
  
  mock('../sensor/Sensor.js', {
    Sensor: class {}
  });
  
  mock('../sensor/SensorEventManager.js', {
    getInstance: () => ({
      on: () => {},
      emit: () => {}
    })
  });
  
  mock('../net2/MessageBus.js', class {
    constructor() {}
    subscribe() {}
    publish() {}
  });
  
  mock('../net2/config.js', { get: () => {} });
  mock('../net2/HostManager.js', class {});
  mock('../net2/SysManager.js', {});
  mock('../net2/NetworkProfileManager.js', {});
  mock('../alarm/Alarm.js', {});
  mock('../alarm/AlarmManager2.js', class {});
  mock('../alarm/PolicyManager2.js', class {
    constructor() {}
  });
  mock('../util/util.js', {
    getPreferredBName: () => '',
    delay: async () => {}
  });
  
  mock('../net2/TagManager.js', {});
  mock('../net2/HostTool.js', class {});

  const NewDeviceTagSensor = require('../sensor/NewDeviceTagSensor');
  sensorInstance = new NewDeviceTagSensor({});
}

function restoreMocks() {
  mock.stopAll();
  // Only drop modules loaded while the mocks were active. Modules already cached
  // before setupMocks() belong to other test files, and evicting them forces those
  // files' lazy require()s to reload the whole dependency tree mid-run, which blows
  // up in redis_manager.js (bluebird promisifyAll on an already-promisified prototype).
  for (const id of Object.keys(require.cache)) {
    if (!cacheSnapshot.has(id)) {
      delete require.cache[id];
    }
  }
}



describe('NewDeviceTagSensor.isFirewallaAP', () => {
  const mockMode = process.env.MOCK_MODE === 'true';

  before(function() {
    this.timeout(60000);
    if (mockMode) {
      setupMocks();
    }
    const NewDeviceTagSensor = require('../sensor/NewDeviceTagSensor');
    sensorInstance = new NewDeviceTagSensor({});

  });

  after(function() {
    if (mockMode) {
      restoreMocks();
    }
  });

  it('should return true for Firewalla AP MAC address "20:6D:31:6"', () => {
    const host = {
      o: {
        mac: '20:6D:31:61:CC:CC',
        dhcpName: 'notfirewalla'
      }
    }
    const result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, true);
  });

  it('should return true for Firewalla Ceiling AP MAC address, perfix "20:6D:31:7" ', () => {
    const host = {
      o: {
        mac: '20:6D:31:71:CC:CC',
        dhcpName: 'notfirewalla'
      }
    }
    const result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, true);
  });

  it('should return false for non-Firewalla MAC address', () => {
    const host = {
      o: {
        mac: '00:11:22:33:44:55',
        dhcpName: 'notfirewalla'
      }
    }
    const result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, false);
  });

});

// the exempt sets: which MACs and addresses the sensor adds to and removes from them, driven through
// the event handlers. the kernel writes are captured from Ipset.restore
describe('NewDeviceTagSensor exempt sets', function () {
  this.timeout(10000);

  const Ipset = require('../net2/Ipset.js');
  const blockControl = require('../control/BlockControl.js');
  const fc = require('../net2/config.js');
  const HostManager = require('../net2/HostManager.js');
  const hostManager = new HostManager();
  const HostTool = require('../net2/HostTool.js');
  const hostTool = new HostTool();
  const C = Ipset.CONSTANTS;
  const A = '00:00:5E:00:53:0A';
  const B = '00:00:5E:00:53:0B';
  const saved = {};
  const Host = require('../net2/Host.js');
  let sensor, ops, refreshes, hosts, featureOn, decisions;

  // the onHostUpdated path only reaches the kernel through a promise it does not return
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));

  function record(mac) {
    hosts[mac] = { o: { mac, lastActiveTimestamp: 1000 } };
    return hosts[mac];
  }

  function exempt(op, mac) {
    return [
      `env ${mac}`,
      `${op} ${C.IPSET_NEW_DEV_EXEMPT_MAC} ${mac}`,
      `${op} ${C.IPSET_NEW_DEV_EXEMPT} ${Host.getIpSetName(mac, 4)}`,
      `${op} ${C.IPSET_NEW_DEV_EXEMPT} ${Host.getIpSetName(mac, 6)}`,
    ];
  }

  before(() => {
    saved.ensureEnv = Host.ensureCreateEnforcementEnv;
    // logged into ops, so a test sees that the per-host sets exist before the restore names them
    Host.ensureCreateEnforcementEnv = async mac => { ops.push(`env ${mac}`); };
    saved.restore = Ipset.restore;
    saved.refresh = blockControl.scheduleRefreshConnmark;
    saved.isFeatureOn = fc.isFeatureOn;
    saved.getHostFastByMAC = hostManager.getHostFastByMAC;
    saved.getHostAsync = hostManager.getHostAsync;
    saved.getAllMACEntries = hostTool.getAllMACEntries;
    saved.getNewDeviceTagConfig = hostManager.getNewDeviceTagConfig;
    Ipset.restore = async lines => { ops.push(...lines); };
    blockControl.scheduleRefreshConnmark = () => { refreshes++; };
    fc.isFeatureOn = (key, dflt) => key === 'new_device_tag' ? featureOn : saved.isFeatureOn(key, dflt);
    hostManager.getHostFastByMAC = mac => hosts[mac] || null;
    hostManager.getHostAsync = async mac => hosts[mac] || null;
    // the records as redis returns them: every field a string, ipv6Addr as JSON
    hostTool.getAllMACEntries = async () => Object.values(hosts).map(host => ({
      mac: host.o.mac,
      lastActiveTimestamp: String(host.o.lastActiveTimestamp),
    }));
    hostManager.getNewDeviceTagConfig = () => ({ tagUids: new Set(['16']), networks: { 'net-a': '16' } });
    const NewDeviceTagSensor = require('../sensor/NewDeviceTagSensor');
    sensor = new NewDeviceTagSensor({});
    // the decision itself needs a box; the tests only check that one is or is not started
    sensor.checkAndExecutePolicy = async (mac, host, decision) => { decisions.push(decision); };
  });

  after(() => {
    Host.ensureCreateEnforcementEnv = saved.ensureEnv;
    Ipset.restore = saved.restore;
    blockControl.scheduleRefreshConnmark = saved.refresh;
    fc.isFeatureOn = saved.isFeatureOn;
    hostManager.getHostFastByMAC = saved.getHostFastByMAC;
    hostManager.getHostAsync = saved.getHostAsync;
    hostTool.getAllMACEntries = saved.getAllMACEntries;
    hostManager.getNewDeviceTagConfig = saved.getNewDeviceTagConfig;
  });

  beforeEach(() => {
    ops = [];
    refreshes = 0;
    hosts = {};
    decisions = [];
    featureOn = true;
    for (const name of ['pending', 'decided', 'recentlyDeleted'])
      sensor[name].clear();
    sensor.applied = { tagUids: new Set(['16']), networks: { 'net-a': '16' } };
  });

  it('a decision exempts the MAC and the per-host IP sets, created first', async () => {
    await sensor.markDecided(A);
    expect(ops).to.deep.equal(exempt('add', A));
    expect(sensor.decided.has(A)).to.equal(true);
  });

  it('a delete that follows a decision reaches the kernel after it', async () => {
    const decided = sensor.markDecided(A);
    const deleted = sensor.onDeviceDelete(null, 'Device:Delete', A);
    await Promise.all([decided, deleted]);
    expect(ops).to.deep.equal(exempt('add', A).concat(exempt('del', A)));
    expect(sensor.decided.has(A)).to.equal(false);
  });

  it('a decision whose device was deleted while it ran writes nothing', async () => {
    record(A);
    const decision = sensor.newDecision(A);
    await sensor.onDeviceDelete(null, 'Device:Delete', A);
    ops = [];
    await sensor.markDecided(A, decision);
    expect(ops).to.deep.equal([]);
    expect(sensor.decided.has(A)).to.equal(false);
    expect(sensor.pending.has(A)).to.equal(false);
  });

  it('a delete removes the MAC and the per-host IP sets, and leaves other devices alone', async () => {
    sensor.decided.add(A);
    sensor.decided.add(B);
    await sensor.onDeviceDelete(null, 'Device:Delete', A.toLowerCase());
    expect(ops).to.deep.equal(exempt('del', A));
    expect(sensor.decided.has(A)).to.equal(false);
    expect(sensor.decided.has(B)).to.equal(true);
    expect(sensor.deletedRecently(A)).to.equal(true);
    expect(refreshes).to.equal(1);
  });

  describe('while a write is running', () => {
    const D = '00:00:5E:00:53:0D';
    let stub, restores, release;

    // the first restore waits for release(), so the calls made meanwhile queue up behind it
    beforeEach(() => {
      stub = Ipset.restore;
      restores = [];
      const gate = new Promise(resolve => { release = resolve; });
      Ipset.restore = async lines => {
        restores.push(lines);
        if (restores.length === 1)
          await gate;
      };
    });

    afterEach(() => {
      Ipset.restore = stub;
    });

    it('the deletes that arrive go out in one restore, in the order they came', async () => {
      const first = sensor.onDeviceDelete(null, 'Device:Delete', A);
      await settle();
      const others = [B, D].map(mac => sensor.onDeviceDelete(null, 'Device:Delete', mac));
      release();
      await Promise.all([first, ...others]);
      const lines = mac => exempt('del', mac).slice(1);
      expect(restores).to.deep.equal([lines(A), lines(B).concat(lines(D))]);
      expect(ops).to.deep.equal([`env ${A}`, `env ${B}`, `env ${D}`]);
    });

    it('a failed restore is reported to the callers waiting for it, and what they queued goes out with the next call', async () => {
      Ipset.restore = async lines => {
        restores.push(lines);
        if (restores.length === 1)
          throw new Error('restore failed');
      };
      const results = await Promise.all([A, B].map(mac =>
        sensor.onDeviceDelete(null, 'Device:Delete', mac).then(() => 'written', err => err.message)));
      expect(results).to.deep.equal(['restore failed', 'restore failed']);
      await sensor.onDeviceDelete(null, 'Device:Delete', D);
      const lines = mac => exempt('del', mac).slice(1);
      expect(restores).to.deep.equal([lines(A), lines(B).concat(lines(D))]);
    });
  });

  it('a delete during the reconcile does not take a device out of the set creation its add lines need', async () => {
    record(A);
    record(B);
    const stub = Host.ensureCreateEnforcementEnv;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    Host.ensureCreateEnforcementEnv = async mac => {
      ops.push(`env ${mac}`);
      if (mac === A)
        await gate;
    };
    try {
      const reconciled = sensor.reconcile();
      await settle();
      const deleted = sensor.onDeviceDelete(null, 'Device:Delete', B);
      release();
      await Promise.all([reconciled, deleted]);
    } finally {
      Host.ensureCreateEnforcementEnv = stub;
    }
    const adds = ops.indexOf(`add ${C.IPSET_NEW_DEV_EXEMPT} ${Host.getIpSetName(B, 4)}`);
    expect(ops.indexOf(`env ${B}`)).to.be.within(0, adds);
    expect(ops.slice(-4)).to.deep.equal(exempt('del', B));
  });

  it('a create without a pending decision is a restored host: decided at once', async () => {
    await sensor.onDeviceCreate(null, 'Device:Create', A.toLowerCase(), { mac: A, ipv4Addr: '192.0.2.10' });
    expect(decisions).to.deep.equal([]);
    expect(sensor.decided.has(A)).to.equal(true);
    expect(ops).to.deep.equal(exempt('add', A));
    ops = [];
    await sensor.onDeviceCreate(null, 'Device:Create', A, { mac: A, ipv4Addr: '192.0.2.10' });
    expect(ops).to.deep.equal([]);
  });

  it('a create after a delete starts one fresh decision instead of exempting', async () => {
    record(A);
    await sensor.onDeviceDelete(null, 'Device:Delete', A);
    ops = [];
    // a decision that is still running, as one waiting for a PPSK candidate
    let finish;
    sensor.checkAndExecutePolicy = async (mac, host, decision) => {
      decisions.push(decision);
      await new Promise(resolve => { finish = resolve; });
    };
    const first = sensor.onDeviceCreate(null, 'Device:Create', A, { mac: A });
    await settle();
    expect(decisions).to.have.length(1);
    expect(sensor.pending.get(A)).to.equal(decisions[0]);
    expect(sensor.decided.has(A)).to.equal(false);
    expect(sensor.deletedRecently(A)).to.equal(false);
    expect(ops).to.deep.equal([]);
    // DeviceHook can publish the same create more than once for one discovery
    await sensor.onDeviceCreate(null, 'Device:Create', A, { mac: A });
    expect(decisions).to.have.length(1);
    finish();
    await first;
    sensor.checkAndExecutePolicy = async (mac, host, decision) => { decisions.push(decision); };
  });

  it('with the feature off a create only consumes the delete marker', async () => {
    record(A);
    await sensor.onDeviceDelete(null, 'Device:Delete', A);
    ops = [];
    featureOn = false;
    await sensor.onDeviceCreate(null, 'Device:Create', A, { mac: A });
    expect(decisions).to.deep.equal([]);
    expect(sensor.decided.has(A)).to.equal(false);
    expect(sensor.deletedRecently(A)).to.equal(false);
    expect(ops).to.deep.equal([]);
  });

  it('a record write for a MAC the sensor knows nothing about takes the create path', async () => {
    sensor.onHostUpdated('Host:Updated', A.toLowerCase(), undefined, { mac: A, ipv4Addr: '192.0.2.10' });
    await settle();
    expect(sensor.decided.has(A)).to.equal(true);
    expect(ops).to.deep.equal(exempt('add', A));
  });

  it('a group change re-renders the rules of the groups that entered or left, with no wait for the start enforcement', async () => {
    const PM2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PM2();
    const sem = require('../sensor/SensorEventManager.js').getInstance();
    const kept = { load: pm2.loadActivePoliciesAsync, enqueue: pm2.enforceOnQueue, send: sem.sendEventToFireMain };
    const jobs = [];
    pm2.loadActivePoliciesAsync = async () => [
      { pid: '1', tag: ['tag:16'] },
      { pid: '2', tag: ['tag:17'] },
      { pid: '3', tag: ['tag:18'] },
      { pid: '4', scope: [A] },
    ];
    pm2.enforceOnQueue = async event => { jobs.push(`${event.action} ${event.policy.pid}`); };
    sem.sendEventToFireMain = () => {};
    try {
      hostManager.getNewDeviceTagConfig = () => ({ tagUids: new Set(['17']), networks: { 'net-a': '17' } });
      sensor.started = true;
      // the queue exists once the start enforcement has begun
      pm2.queue = {};
      await sensor.applyConfig();
      expect(jobs).to.deep.equal(['reenforce 1', 'reenforce 2']);
      expect([...sensor.applied.tagUids]).to.deep.equal(['17']);
    } finally {
      pm2.loadActivePoliciesAsync = kept.load;
      pm2.enforceOnQueue = kept.enqueue;
      sem.sendEventToFireMain = kept.send;
      delete pm2.queue;
      hostManager.getNewDeviceTagConfig = () => ({ tagUids: new Set(['16']), networks: { 'net-a': '16' } });
      sensor.started = false;
    }
  });

  it('a group change before the policy queue exists re-renders nothing, the start enforcement renders from the same config', async () => {
    const PM2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PM2();
    const sem = require('../sensor/SensorEventManager.js').getInstance();
    const kept = { load: pm2.loadActivePoliciesAsync, enqueue: pm2.enforceOnQueue, send: sem.sendEventToFireMain };
    let loaded = 0;
    pm2.loadActivePoliciesAsync = async () => { loaded++; return [{ pid: '1', tag: ['tag:17'] }]; };
    pm2.enforceOnQueue = async () => { throw new Error('no queue'); };
    sem.sendEventToFireMain = () => {};
    try {
      expect(pm2.queue).to.equal(undefined);
      hostManager.getNewDeviceTagConfig = () => ({ tagUids: new Set(['17']), networks: { 'net-a': '17' } });
      sensor.started = true;
      await sensor.applyConfig();
      expect(loaded).to.equal(0);
      expect([...sensor.applied.tagUids]).to.deep.equal(['17']);
    } finally {
      pm2.loadActivePoliciesAsync = kept.load;
      pm2.enforceOnQueue = kept.enqueue;
      sem.sendEventToFireMain = kept.send;
      hostManager.getNewDeviceTagConfig = () => ({ tagUids: new Set(['16']), networks: { 'net-a': '16' } });
      sensor.started = false;
    }
  });

  it('a network is added to the network set only after its own sets exist', async () => {
    const NetworkProfile = require('../net2/NetworkProfile.js');
    const kept = { env: NetworkProfile.ensureCreateEnforcementEnv, add: Ipset.add, del: Ipset.del };
    NetworkProfile.ensureCreateEnforcementEnv = async uuid => { ops.push(`net env ${uuid}`); };
    Ipset.add = async (set, member) => { ops.push(`add ${set} ${member}`); };
    Ipset.del = async (set, member) => { ops.push(`del ${set} ${member}`); };
    try {
      await sensor.setNetwork('net-b', true);
      expect(ops).to.deep.equal([
        'net env net-b',
        `add ${C.IPSET_NEW_DEV_NETWORK} ${NetworkProfile.getNetIpsetName('net-b')}`,
        `add ${C.IPSET_NEW_DEV_NETWORK} ${NetworkProfile.getNetIpsetName('net-b', 6)}`,
        `add ${C.IPSET_NEW_DEV_NETWORK} ${NetworkProfile.getNetLinklocalIpsetName('net-b')}`,
      ]);
      ops = [];
      await sensor.setNetwork('net-b', false);
      expect(ops.filter(op => op.startsWith('net env'))).to.deep.equal([]);
      expect(ops).to.have.length(3);
    } finally {
      NetworkProfile.ensureCreateEnforcementEnv = kept.env;
      Ipset.add = kept.add;
      Ipset.del = kept.del;
    }
  });

  it('the reconcile decides every known host except pending and recently deleted ones', async () => {
    const CPENDING = '00:00:5E:00:53:0C';
    const DDELETED = '00:00:5E:00:53:0D';
    record(A);
    record(B);
    record(CPENDING);
    record(DDELETED);
    sensor.newDecision(CPENDING);
    sensor.recentlyDeleted.set(DDELETED, Date.now());
    await sensor.reconcile();
    expect(ops).to.deep.equal([
      `env ${A}`,
      `env ${B}`,
      `create ${C.IPSET_NEW_DEV_EXEMPT_MAC} hash:mac`,
      `create ${C.IPSET_NEW_DEV_EXEMPT} list:set`,
    ].concat(exempt('add', A).slice(1), exempt('add', B).slice(1)));
    expect([...sensor.decided]).to.have.members([A, B]);
  });
});