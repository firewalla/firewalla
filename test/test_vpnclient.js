/*    Copyright 2016-2024 Firewalla Inc.
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

let log = require('../net2/logger.js')(__filename, 'info');

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const WGVPNClient = require('../extension/vpnclient/WGVPNClient.js');
const OCDockerClient = require('../extension/vpnclient/docker/OCDockerClient.js');
const GostDockerClient = require('../extension/vpnclient/docker/GostDockerClient.js');
const HysteriaDockerClient = require('../extension/vpnclient/docker/HysteriaDockerClient.js');
const VirtWanGroup = require('../net2/VirtWanGroup.js');
const virtWanGroupManager = require('../net2/VirtWanGroupManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const { DEFAULT_TIMEOUT: DIG_TIMEOUT, DEFAULT_TRIES: DIG_TRIES } = require('../util/DNSUpstreamHealthCheck.js');
const Ipset = require('../net2/Ipset.js');
const fc = require('../net2/config.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Test vpnClient getAttributes', function(){
    this.timeout(30000);

    beforeEach((done) => {
      done();
    });
  
    afterEach((done) => {
      done();
    });

    it('should get openvpn attrs', async()=> {
        const profileIds = await OpenVPNClient.listProfileIds();
        for (const profileId of profileIds) {
          const attrs = await new OpenVPNClient({ profileId }).getAttributes()
          log.debug(`profile ${profileId}:`, attrs)
          expect(attrs.dnsServers).to.not.be.null;
        }
    });

    it('should get wgvpn attrs', async()=> {
        const profileIds = await WGVPNClient.listProfileIds();
        for (const profileId of profileIds) {
          const attrs = await new WGVPNClient({ profileId }).getAttributes()
          log.debug(`profile ${profileId}:`, attrs)
          expect(attrs.dnsServers).to.not.be.null;
        }
    });

    it('should get sslvpn attrs', async()=> {
        const profileIds = await OCDockerClient.listProfileIds();
        for (const profileId of profileIds) {
          const attrs = await new OCDockerClient({ profileId }).getAttributes()
          log.debug(`profile ${profileId}:`, attrs)
          expect(attrs.dnsServers).to.not.be.null;
        }
    });

  });

  describe('Test vpnClient getAttributes', function(){
    this.timeout(30000);

    it('should run ping test', async()=> {
      const profileIds = await WGVPNClient.listProfileIds();
      for (const profileId of profileIds) {
        const client = new WGVPNClient({ profileId });
        const attrs = await client.getAttributes();
        if (!attrs.status) {
          continue
        }
        for (const target of attrs.dnsServers){
          log.debug("pingTest", await client._runPingTest(target));
        }
      }
    });

    it('should run _isInternetAvailable', async() => {
      const profileIds = await WGVPNClient.listProfileIds();
      for (const profileId of profileIds) {
        const client = new WGVPNClient({ profileId });
        const attrs = await client.getAttributes();
        if (!attrs.status) {
          continue
        }
        client._started = true;
        await client._isInternetAvailable();
      }

    })
  });

describe('Test vpnClient connectivity state cache race', function() {
  this.timeout(3000);

  it('should not overwrite stopped client cached state with stale true result', async() => {
    const client = Object.create(VPNClient.prototype);
    client.profileId = `test_${Date.now()}`;
    client.settings = { overrideDefaultRoute: false };
    client._started = true;
    client._restarting = false;
    client._lastStartTime = null;

    const cachedStates = [];
    const cachedInternetStates = [];
    client._setCachedState = async(state) => cachedStates.push(state);
    client._setCachedInternetState = async(state) => cachedInternetStates.push(state);

    let releaseLinkCheck;
    const linkCheckStarted = new Promise((resolve) => {
      client._isLinkUp = async() => {
        resolve();
        await new Promise((release) => {
          releaseLinkCheck = release;
        });
        return true;
      };
    });

    const checkPromise = client._checkConnectivity();
    await linkCheckStarted;

    client._started = false;
    releaseLinkCheck();
    await checkPromise;

    expect(cachedStates).to.eql([false]);
    expect(cachedInternetStates).to.eql([null]);
  });
});

describe('Test vpnClient cached states', function() {
  this.timeout(3000);

  const rclient = require('../util/redis_manager.js').getRedisClient();
  let store;
  before(() => {
    store = {};
    rclient.getAsync = async(key) => key in store ? store[key] : null;
    rclient.setAsync = async(key, value) => { store[key] = String(value); };
    rclient.expireAsync = async() => {};
    rclient.delAsync = async(...keys) => keys.forEach(key => delete store[key]);
  });
  after(() => {
    for (const name of ['getAsync', 'setAsync', 'expireAsync', 'delAsync'])
      delete rclient[name];
  });

  function newClient() {
    const client = Object.create(VPNClient.prototype);
    client.profileId = 'cached_states';
    return client;
  }

  it('should keep the link and the internet of a client apart', async() => {
    const client = newClient();
    await client._setCachedState(true);
    await client._setCachedInternetState(false);
    expect(await client._getCachedState()).to.equal(true);
    expect(await client._getCachedInternetState()).to.equal(false);
    expect(store).to.eql({ 'VC:cached_states:connState': 'true', 'VC:cached_states:internetState': 'false' });
  });

  it('should have no internet state for a client that is not judged', async() => {
    const client = newClient();
    await client._setCachedInternetState(true);
    await client._setCachedInternetState(null);
    expect(await client._getCachedInternetState()).to.equal(null);
    expect(await client._getCachedState()).to.equal(true);
  });

  it('should delete both states with the client', async() => {
    const client = newClient();
    await client._setCachedInternetState(true);
    await client._deleteCachedState();
    expect(store).to.eql({});
  });

  it('should report the internet in the attributes, next to the status of the link', async() => {
    const client = newClient();
    for (const name of ['loadSettings', 'getEffectiveRoutedSubnets', 'getStatistics', 'getMessage', 'loadJSONConfig',
      '_getRemoteIP', '_getRemoteIP6', '_getLocalIP', '_getDNSServers'])
      client[name] = async() => null;
    vpnClientEnforcer.getRtId = async() => 100;
    try {
      await client._setCachedState(true);
      await client._setCachedInternetState(false);
      const attrs = await client.getAttributes();
      expect([attrs.status, attrs.internet]).to.eql([true, false]);
      await client._setCachedInternetState(null);
      expect((await client.getAttributes()).internet).to.equal(null);
    } finally {
      delete vpnClientEnforcer.getRtId;
    }
  });
});

// stub clients for the internet check below, no redis or box needed
function newStubClient(settings) {
  const client = Object.create(VPNClient.prototype);
  client.profileId = `test_${Date.now()}`;
  client.settings = Object.assign({ overrideDefaultRoute: true }, settings);
  client._started = true;
  client._restarting = false;
  client._lastStartTime = null;
  client.cachedLinks = [];
  client.cachedInternetStates = [];
  client._setCachedState = async(state) => client.cachedLinks.push(state);
  client._setCachedInternetState = async(state) => client.cachedInternetStates.push(state);
  client._isLinkUp = async() => true;
  client._resetInternetCounters();
  return client;
}

// the listeners that fn adds to the shared event manager, removed again by the returned remove()
function captureListeners(events, fn) {
  const before = {};
  events.forEach(e => before[e] = sem.listeners(e));
  fn();
  const added = {};
  events.forEach(e => added[e] = sem.listeners(e).filter(l => !before[e].includes(l)));
  return {
    added,
    remove: () => events.forEach(e => added[e].forEach(l => sem.removeListener(e, l)))
  };
}

// what a link_state_change says about the tunnel
function label(e) {
  if (!e.link)
    return 'link-down';
  return e.internet ? 'ready' : 'no-internet';
}

describe('Test vpnClient internet check hysteresis', function() {
  this.timeout(3000);

  let emitted, origEmitEvent;
  beforeEach(() => {
    emitted = [];
    origEmitEvent = sem.emitEvent;
    sem.emitEvent = (event) => emitted.push(event);
  });
  afterEach(() => {
    sem.emitEvent = origEmitEvent;
  });

  // runs one check per verdict, returns what each of them emitted
  async function run(client, verdicts) {
    const rounds = [];
    for (const verdict of verdicts) {
      client._isInternetAvailable = async() => verdict;
      emitted.length = 0;
      await client._checkConnectivity();
      rounds.push(emitted.map(label).join());
    }
    return rounds;
  }

  it('should start with 0 failures and 1 success short of recovery', () => {
    const client = newStubClient();
    expect(client.internetFailureCount).to.equal(0);
    expect(client.internetSuccessCount).to.equal(1);
    expect(client.internetUnknownCount).to.equal(0);
    client.internetFailureCount = 3;
    client.internetSuccessCount = 0;
    client.internetUnknownCount = 2;
    client._resetInternetCounters();
    expect(client.internetFailureCount).to.equal(0);
    expect(client.internetSuccessCount).to.equal(1);
    expect(client.internetUnknownCount).to.equal(0);
  });

  it('should promote on the first good sample after a reset', async() => {
    expect(await run(newStubClient(), [true])).to.eql(['ready']);
  });

  it('should need 2 consecutive failures after a reset', async() => {
    expect(await run(newStubClient(), [false])).to.eql(['']);
    expect(await run(newStubClient(), [false, false])).to.eql(['', 'no-internet']);
    // a failure spends the head start of the first good sample, so 2 good samples are needed again
    expect(await run(newStubClient(), [false, true, true, true, true])).to.eql(['', '', 'ready', 'ready', 'ready']);
  });

  it('should break on the 2nd failure and recover on the 2nd success', async() => {
    const client = newStubClient();
    expect(await run(client, [true, false, false, true, true, true, true, true])).to.eql([
      'ready', '', 'no-internet', '', 'ready', 'ready', 'ready', 'ready'
    ]);
  });

  it('should take the internet up again on the 2nd good sample, not the 1st', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    expect(await run(client, [true, true])).to.eql(['', 'ready']);
  });

  it('should restart the success count on a failure while recovering', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    expect(await run(client, [true, false, true, true])).to.eql(['', '', '', 'ready']);
  });

  it('should not count a sample that could not tell', async() => {
    expect(await run(newStubClient(), [false, null])).to.eql(['', '']);
    expect(await run(newStubClient(), [false, null, false])).to.eql(['', '', 'no-internet']);
  });

  it('should fall back to the link-only verdict after 5 samples that could not tell', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    expect(await run(client, [null, null, null, null, null])).to.eql([
      'no-internet', 'no-internet', 'no-internet', 'no-internet', 'ready'
    ]);
    expect(client.internetUnknownCount).to.equal(5);
  });

  it('should count samples that could not tell only while they are consecutive', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    const rounds = await run(client, [null, null, null, null, false, null, null, null, null]);
    expect(rounds.filter(r => r === 'ready')).to.eql([]);
    expect(client.internetUnknownCount).to.equal(4);
  });

  it('should report the link and the internet as two states, and keep the status to the link', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    expect(emitted.map(e => [e.type, e.link, e.internet])).to.eql([['link_state_change', true, false]]);
    // pending rounds write nothing. the status stays true while the internet is down
    expect(client.cachedLinks).to.eql([true, true]);
    expect(client.cachedInternetStates).to.eql([true, false]);
  });

  it('should report a broken link without internet either, and without probing', async() => {
    const client = newStubClient();
    client._isLinkUp = async() => false;
    client._isInternetAvailable = async() => { throw new Error('should not probe'); };
    await client._checkConnectivity();
    expect(emitted.map(e => [e.type, e.link, e.internet])).to.eql([['link_state_change', false, false]]);
    expect(client.cachedLinks).to.eql([false]);
    expect(client.cachedInternetStates).to.eql([false]);
  });

  describe('a client that does not override the default route', () => {
    let origHasMember;
    beforeEach(() => origHasMember = VirtWanGroup.hasMember);
    afterEach(() => VirtWanGroup.hasMember = origHasMember);

    it('should not be probed outside a group', async() => {
      VirtWanGroup.hasMember = () => false;
      const client = newStubClient({ overrideDefaultRoute: false });
      client._isInternetAvailable = async() => { throw new Error('should not probe'); };
      await client._checkConnectivity();
      expect(emitted.map(e => [e.link, e.internet])).to.eql([[true, true]]);
    });

    it('should be probed as a member of a group, which routes through it', async() => {
      VirtWanGroup.hasMember = () => true;
      const client = newStubClient({ overrideDefaultRoute: false });
      expect(await run(client, [false, false])).to.eql(['', 'no-internet']);
    });
  });

  it('should ping less in the check after a start, which also tells the group to refresh', async() => {
    const client = newStubClient();
    const asked = [];
    client._isInternetAvailable = async(quick) => { asked.push(quick); return true; };
    await client._checkConnectivity(true);
    await client._checkConnectivity();
    expect(asked).to.eql([true, false]);
    expect(emitted.map(e => e.routeUpdated)).to.eql([true, false]);
  });

  describe('a route update', () => {
    let origHasMember;
    beforeEach(() => origHasMember = VirtWanGroup.hasMember);
    afterEach(() => VirtWanGroup.hasMember = origHasMember);

    // the cached internet verdict is what the client had before the update
    function routeUpdateClient(settings, cached, inGroup = false) {
      VirtWanGroup.hasMember = () => inGroup;
      const client = newStubClient(settings);
      client.refreshes = 0;
      client._scheduleRefreshRoutes = () => client.refreshes++;
      client._getCachedInternetState = async() => cached;
      return client;
    }
    const reported = () => emitted.map(e => [e.link, e.internet, e.routeUpdated]);

    it('should report the link up and keep the internet of the last check', async() => {
      const client = routeUpdateClient({}, false);
      await client._handleRouteUpdated();
      expect(reported()).to.eql([[true, false, true]]);
      expect(client.refreshes).to.equal(1);
    });

    it('should report the internet up when there is no last verdict', async() => {
      await routeUpdateClient({}, null)._handleRouteUpdated();
      expect(reported()).to.eql([[true, true, true]]);
    });

    it('should keep the internet of a member that does not override the default route', async() => {
      await routeUpdateClient({ overrideDefaultRoute: false }, false, true)._handleRouteUpdated();
      expect(reported()).to.eql([[true, false, true]]);
    });

    it('should report the internet up for a client that is not probed', async() => {
      // its last verdict only copies a link that was down
      await routeUpdateClient({ overrideDefaultRoute: false }, false)._handleRouteUpdated();
      expect(reported()).to.eql([[true, true, true]]);
    });

    it('should only refresh the routes of a client that is stopped', async() => {
      const client = routeUpdateClient({}, false);
      client._started = false;
      await client._handleRouteUpdated();
      expect(emitted).to.eql([]);
      expect(client.refreshes).to.equal(1);
    });

    it('should report nothing when the client is stopped while the last verdict is read', async() => {
      const client = routeUpdateClient({}, false);
      client._getCachedInternetState = async() => { client._started = false; return false; };
      await client._handleRouteUpdated();
      expect(emitted).to.eql([]);
    });
  });

  it('should discard a sample that finishes after the client is stopped', async() => {
    const client = newStubClient();
    client._isInternetAvailable = async() => { client._started = false; return false; };
    await client._checkConnectivity();
    await client._checkConnectivity();
    expect(emitted).to.eql([]);
    expect(client.cachedLinks).to.eql([false, false]);
    expect(client.cachedInternetStates).to.eql([null, null]);
  });
});

// the client acts on the link only: the internet is for the virtual wan group
describe('Test vpnClient link_state_change listener', function() {
  this.timeout(3000);

  const events = ['link_state_change', 'link_wan_switched'];
  let hooks, calls, saved;
  beforeEach(() => {
    hooks = [];
    calls = [];
    saved = { flush: Ipset.flush, ensure: VPNClient.ensureCreateEnforcementEnv, isFeatureOn: fc.isFeatureOn };
    Ipset.flush = async(name) => calls.push(`flush ${name}`);
    VPNClient.ensureCreateEnforcementEnv = async() => {};
    fc.isFeatureOn = () => false; // no alarm, which needs a box
  });
  afterEach(() => {
    hooks.forEach(h => h.remove());
    Ipset.flush = saved.flush;
    VPNClient.ensureCreateEnforcementEnv = saved.ensure;
    fc.isFeatureOn = saved.isFeatureOn;
  });

  // a client whose tunnel was up, with everything the listener touches stubbed. returns the listener
  function hook(client, autoReconnect = true) {
    client._currentState = true;
    client._autoReconnectNeeded = async() => autoReconnect;
    client.restarts = 0;
    client.scheduleRestart = () => client.restarts++;
    client.refreshes = 0;
    client._scheduleRefreshRoutes = () => client.refreshes++;
    for (const name of ['_disableDNSRoute', '_disablePBRDNSRoute'])
      client[name] = async(mode) => calls.push(`${name} ${mode}`);
    client._resetRouteMarkInRedis = async() => calls.push('_resetRouteMarkInRedis');
    const listeners = captureListeners(events, () => client.hookLinkStateChange());
    hooks.push(listeners);
    return listeners.added.link_state_change[0];
  }

  const state = (client, link, internet) => ({ type: 'link_state_change', profileId: client.profileId, link, internet });

  it('should do nothing for a loss of internet behind a tunnel that is up', async() => {
    const client = newStubClient();
    const onChange = hook(client);
    await onChange(state(client, true, false));
    expect(calls).to.eql([]);
    expect(client.restarts).to.equal(0);
    expect(client.refreshes).to.equal(0);
    expect(client._currentState).to.equal(true);
  });

  it('should restart the tunnel for a broken link', async() => {
    const client = newStubClient();
    const onChange = hook(client);
    await onChange(state(client, false, false));
    await onChange(state(client, false, false));
    expect(client.restarts).to.equal(2);
    expect(client._currentState).to.equal(false);
  });

  it('should not restart a broken link when autoReconnect is off', async() => {
    const client = newStubClient();
    const onChange = hook(client, false);
    await onChange(state(client, false, false));
    expect(client.restarts).to.equal(0);
  });

  it('should ignore events of other clients', async() => {
    const client = newStubClient();
    const onChange = hook(client);
    await onChange(Object.assign(state(client, false, false), { profileId: `${client.profileId}_other` }));
    expect(calls).to.eql([]);
    expect(client.restarts).to.equal(0);
  });

  it('should restore a tunnel that is back, whatever the internet behind it', async() => {
    for (const internet of [true, false]) {
      const client = newStubClient();
      const onChange = hook(client);
      await onChange(state(client, false, false));
      expect(client.refreshes).to.equal(0);
      await onChange(state(client, true, internet));
      expect(client.refreshes).to.equal(1);
      expect(client._currentState).to.equal(true);
      // nothing to restore any more
      await onChange(state(client, true, !internet));
      expect(client.refreshes).to.equal(1);
    }
  });

  it('should reset the counters when FireApi starts the client', async() => {
    const client = newStubClient();
    client.internetFailureCount = 3;
    client.internetSuccessCount = 0;
    client.internetUnknownCount = 3;
    client._started = false;
    const hooked = captureListeners(['VPNClient:SettingsChanged', 'VPNClient:Stopped', 'VPNClient:Started'], () => client.hookSettingsChange());
    try {
      await hooked.added['VPNClient:Started'][0]({ profileId: client.profileId });
    } finally {
      hooked.remove();
    }
    expect(client._started).to.equal(true);
    expect([client.internetFailureCount, client.internetSuccessCount, client.internetUnknownCount]).to.eql([0, 1, 0]);
  });

  describe('side effects of a broken link', () => {
    async function breakLink(settings) {
      const client = newStubClient(settings);
      await hook(client)(state(client, false, false));
      return client;
    }

    it('should clear only the soft routes of a client with strictVPN', async() => {
      const client = await breakLink({ strictVPN: true });
      expect(calls).to.eql([
        `flush ${VPNClient.getRouteIpsetName(client.profileId, false)}`,
        `flush ${VPNClient.getPBRRouteIpsetName(client.profileId, false)}`,
        '_disableDNSRoute soft',
        '_disablePBRDNSRoute soft'
      ]);
      expect(client.restarts).to.equal(1);
    });

    it('should clear the hard routes too for a client without strictVPN', async() => {
      const client = await breakLink({ strictVPN: false });
      expect(calls).to.eql([
        `flush ${VPNClient.getRouteIpsetName(client.profileId, false)}`,
        `flush ${VPNClient.getPBRRouteIpsetName(client.profileId, false)}`,
        '_disableDNSRoute soft',
        '_disablePBRDNSRoute soft',
        `flush ${VPNClient.getRouteIpsetName(client.profileId)}`,
        '_disableDNSRoute hard',
        '_resetRouteMarkInRedis'
      ]);
      expect(client.restarts).to.equal(1);
    });
  });
});

describe('Test vpnClient internet probes', function() {
  this.timeout(3000);

  describe('_pingVerdict', () => {
    const r = (successCount, totalCount = 8) => ({ successCount, totalCount });

    it('should pass a target at half of the replies', () => {
      expect(VPNClient._pingVerdict([r(4)])).to.equal(true);
      expect(VPNClient._pingVerdict([r(3)])).to.equal(false);
      expect(VPNClient._pingVerdict([r(1, 1)])).to.equal(true);
      expect(VPNClient._pingVerdict([r(0, 1)])).to.equal(false);
    });

    it('should pass when any target passes', () => {
      expect(VPNClient._pingVerdict([r(0), r(8), r(0)])).to.equal(true);
      expect(VPNClient._pingVerdict([r(null), r(8)])).to.equal(true);
    });

    it('should fail only when every target was conclusive', () => {
      expect(VPNClient._pingVerdict([r(0), r(1), r(3)])).to.equal(false);
      expect(VPNClient._pingVerdict([r(0), r(null)])).to.equal(null);
      expect(VPNClient._pingVerdict([r(null), r(null)])).to.equal(null);
    });
  });

  describe('_digVerdict', () => {
    it('should take any reply as internet, and no reply as none', () => {
      expect(VPNClient._digVerdict(0)).to.equal(true);
      expect(VPNClient._digVerdict(9)).to.equal(false);
    });

    it('should take anything else as unknown', () => {
      for (const code of [1, 2, 3, 4, 5, 6, 10, 'ENOENT', 'EPERM', null, undefined])
        expect(VPNClient._digVerdict(code), `code ${code}`).to.equal(null);
    });
  });

  describe('ping output', () => {
    it('should read the received count', () => {
      expect(VPNClient._parsePingReceived('8 packets transmitted, 8 received, 0% packet loss, time 7010ms')).to.equal(8);
      expect(VPNClient._parsePingReceived('8 packets transmitted, 3 packets received, 62% packet loss')).to.equal(3);
    });

    it('should read total loss as 0, which is what ping prints when it exits 1', () => {
      expect(VPNClient._parsePingReceived('8 packets transmitted, 0 received, 100% packet loss, time 7165ms')).to.equal(0);
    });

    it('should return null when there is no statistics line', () => {
      expect(VPNClient._parsePingReceived('')).to.equal(null);
      expect(VPNClient._parsePingReceived(undefined)).to.equal(null);
      expect(VPNClient._parsePingReceived('ping: invalid argument: \'null\'')).to.equal(null);
    });

    it('should clamp the count, and say nothing about an invalid target', async() => {
      const client = newStubClient();
      for (const [count, expected] of [[99, 8], [8, 8], [3, 3], [1, 1], [0, 8], [-1, 8], [2.5, 8], [undefined, 8]]) {
        const result = await client._runPingTest('not an address', count);
        expect(result, `count ${count}`).to.eql({ target: 'not an address', totalCount: expected, successCount: null });
      }
    });

    // ping exits 1 on total loss and still prints its statistics, which are only in the stdout of the failed exec
    describe('_runPingTest through sudo', () => {
      let dir, saved;
      before(() => {
        // a sudo that prints $FAKE_OUT and exits with $FAKE_EXIT, the way ping does
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakesudo-'));
        fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/sh\necho "$FAKE_OUT"\nexit $FAKE_EXIT\n', { mode: 0o755 });
        saved = { PATH: process.env.PATH };
        process.env.PATH = `${dir}:${saved.PATH}`;
        vpnClientEnforcer.getRtId = async() => 1;
      });
      after(() => {
        process.env.PATH = saved.PATH;
        delete vpnClientEnforcer.getRtId; // the real one is a prototype method
        delete process.env.FAKE_OUT;
        delete process.env.FAKE_EXIT;
        fs.unlinkSync(path.join(dir, 'sudo'));
        fs.rmdirSync(dir);
      });

      async function ping(exit, out) {
        process.env.FAKE_EXIT = String(exit);
        process.env.FAKE_OUT = out;
        const client = newStubClient();
        client.getVpnIP4s = async() => [];
        client.getInterfaceName = () => 'vpn_test';
        return client._runPingTest('1.1.1.1', 8);
      }

      it('should count a ping that got its replies', async() => {
        const result = await ping(0, '8 packets transmitted, 8 received, 0% packet loss, time 7010ms');
        expect(result.successCount).to.equal(8);
      });

      it('should read the statistics of a ping that exits 1 on total loss', async() => {
        const result = await ping(1, '8 packets transmitted, 0 received, 100% packet loss, time 7165ms');
        expect(result.successCount).to.equal(0);
        expect(VPNClient._pingVerdict([result])).to.equal(false);
      });

      it('should say nothing for a ping that failed without statistics', async() => {
        const result = await ping(2, 'ping: connect: Network is unreachable');
        expect(result.successCount).to.equal(null);
        expect(VPNClient._pingVerdict([result])).to.equal(null);
      });
    });
  });

  describe('_runPingTests', () => {
    function pingStub(client) {
      const calls = [];
      client._runPingTest = async(target, count) => {
        calls.push([target, count]);
        return { target, totalCount: count, successCount: count };
      };
      return calls;
    }

    it('should use 3 public targets by default', async() => {
      const client = newStubClient();
      const calls = pingStub(client);
      expect(await client._runPingTests()).to.equal(true);
      expect(calls).to.eql([['1.1.1.1', 8], ['8.8.8.8', 8], ['9.9.9.9', 8]]);
    });

    it('should use the first 3 configured targets and the configured count', async() => {
      const client = newStubClient({ pingTestTargets: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'], pingTestCount: 3 });
      const calls = pingStub(client);
      await client._runPingTests();
      expect(calls).to.eql([['10.0.0.1', 3], ['10.0.0.2', 3], ['10.0.0.3', 3]]);
    });

    it('should ping less when asked for the check after a start, but never more than configured', async() => {
      const client = newStubClient();
      const calls = pingStub(client);
      await client._runPingTests(true);
      expect(calls).to.eql([['1.1.1.1', 3], ['8.8.8.8', 3], ['9.9.9.9', 3]]);
      const few = newStubClient({ pingTestCount: 2 });
      const fewCalls = pingStub(few);
      await few._runPingTests(true);
      expect(fewCalls.map(c => c[1])).to.eql([2, 2, 2]);
    });
  });

  describe('_runDnsTest', () => {
    function dnsStub(client, servers, execResult) {
      const calls = [];
      client._isDnsTestSupported = () => true;
      client._getDNSServers = async() => servers;
      client._execWithClientMark = async(args, options) => {
        calls.push({ args, options });
        const result = execResult(args);
        if (result !== 0)
          throw Object.assign(new Error('dig failed'), { code: result });
        return { stdout: '' };
      };
      return calls;
    }

    it('should be skipped without routeDNS, on a platform without cgroup_sock_mark, or without an IPv4 server', async() => {
      let client = newStubClient({ routeDNS: false });
      let calls = dnsStub(client, ['10.8.0.1'], () => 9);
      expect(await client._runDnsTest()).to.equal(true);
      client = newStubClient({ routeDNS: true });
      calls = dnsStub(client, ['10.8.0.1'], () => 9);
      client._isDnsTestSupported = () => false;
      expect(await client._runDnsTest()).to.equal(true);
      client = newStubClient({ routeDNS: true });
      calls = dnsStub(client, ['fd00::1'], () => 9);
      expect(await client._runDnsTest()).to.equal(true);
      client = newStubClient({ routeDNS: true });
      calls = dnsStub(client, [], () => 9);
      expect(await client._runDnsTest()).to.equal(true);
      expect(calls).to.eql([]);
    });

    it('should ask up to 3 IPv4 servers under the mark, and kill a hung dig', async() => {
      const client = newStubClient({ routeDNS: true });
      const calls = dnsStub(client, ['fd00::1', '10.8.0.1', '10.8.0.2', '10.8.0.3', '10.8.0.4'], () => 0);
      expect(await client._runDnsTest()).to.equal(true);
      expect(calls.map(c => c.args)).to.eql([
        ['dig', '@10.8.0.1', 'github.com', 'A', '+short', '+time=3', '+tries=2'],
        ['dig', '@10.8.0.2', 'github.com', 'A', '+short', '+time=3', '+tries=2'],
        ['dig', '@10.8.0.3', 'github.com', 'A', '+short', '+time=3', '+tries=2']
      ]);
      for (const call of calls)
        expect(call.options).to.eql({ timeout: 10000, killSignal: 'SIGKILL' });
      // a dig without a reply has to end by itself, with exit 9, before it is killed
      expect(calls[0].options.timeout).to.be.above(DIG_TIMEOUT * DIG_TRIES * 1000);
    });

    it('should use the configured domain', async() => {
      const client = newStubClient({ routeDNS: true, dnsTestDomain: 'dns.example.com' });
      const calls = dnsStub(client, ['10.8.0.1'], () => 0);
      await client._runDnsTest();
      expect(calls[0].args[2]).to.equal('dns.example.com');
    });

    it('should not run a domain that is not an FQDN', async() => {
      for (const dnsTestDomain of ['a b', 'x.com; reboot', '$(id).com', 'localhost', 5, {}]) {
        const client = newStubClient({ routeDNS: true, dnsTestDomain });
        const calls = dnsStub(client, ['10.8.0.1'], () => 0);
        expect(await client._runDnsTest(), `domain ${dnsTestDomain}`).to.equal(null);
        expect(calls).to.eql([]);
      }
    });

    it('should take a reply of any kind as internet', async() => {
      const client = newStubClient({ routeDNS: true });
      dnsStub(client, ['10.8.0.1', '10.8.0.2'], (args) => args[1] === '@10.8.0.1' ? 9 : 0);
      expect(await client._runDnsTest()).to.equal(true);
    });

    it('should fail only when every server gave no reply', async() => {
      let client = newStubClient({ routeDNS: true });
      dnsStub(client, ['10.8.0.1', '10.8.0.2'], () => 9);
      expect(await client._runDnsTest()).to.equal(false);
      client = newStubClient({ routeDNS: true });
      dnsStub(client, ['10.8.0.1', '10.8.0.2'], (args) => args[1] === '@10.8.0.1' ? 9 : 1);
      expect(await client._runDnsTest()).to.equal(null);
    });

    it('should take a dig that could not run or was killed as unknown', async() => {
      for (const code of ['ENOENT', null, 3, 10]) {
        const client = newStubClient({ routeDNS: true });
        dnsStub(client, ['10.8.0.1'], () => code);
        expect(await client._runDnsTest(), `code ${code}`).to.equal(null);
      }
    });
  });

  describe('_checkInternetAvailability', () => {
    async function check(ping, dns) {
      const client = newStubClient();
      const stages = [];
      client._runPingTests = async() => { stages.push('ping'); return ping; };
      client._runDnsTest = async() => { stages.push('dns'); return dns; };
      return [await client._checkInternetAvailability(), stages.join()];
    }

    it('should fail when the ping stage fails, without running DNS', async() => {
      expect(await check(false, true)).to.eql([false, 'ping']);
    });

    it('should fail when the DNS stage fails', async() => {
      expect(await check(true, false)).to.eql([false, 'ping,dns']);
      expect(await check(null, false)).to.eql([false, 'ping,dns']);
    });

    it('should treat an inconclusive DNS stage like a skipped one', async() => {
      expect(await check(true, null)).to.eql([true, 'ping,dns']);
      expect(await check(true, true)).to.eql([true, 'ping,dns']);
    });

    it('should not tell when the ping stage could not', async() => {
      expect(await check(null, true)).to.eql([null, 'ping,dns']);
      expect(await check(null, null)).to.eql([null, 'ping,dns']);
    });

    it('should hand the quick flag to the ping stage', async() => {
      const client = newStubClient();
      const asked = [];
      client._runPingTests = async(quick) => { asked.push(quick); return true; };
      client._runDnsTest = async() => true;
      await client._checkInternetAvailability(true);
      await client._checkInternetAvailability();
      expect(asked).to.eql([true, false]);
    });
  });

  describe('_isInternetAvailable', () => {
    it('should not tell for a client that is stopped or whose link is down', async() => {
      const client = newStubClient();
      client._checkInternetAvailability = async() => { throw new Error('should not probe'); };
      client._started = false;
      expect(await client._isInternetAvailable()).to.equal(null);
      client._started = true;
      client._isLinkUp = async() => false;
      expect(await client._isInternetAvailable()).to.equal(null);
    });

    it('should return what the check says', async() => {
      for (const verdict of [true, false, null]) {
        const client = newStubClient();
        client._checkInternetAvailability = async() => verdict;
        expect(await client._isInternetAvailable()).to.equal(verdict);
      }
    });

    it('should hand the quick flag to the check', async() => {
      const client = newStubClient();
      const asked = [];
      client._checkInternetAvailability = async(quick) => { asked.push(quick); return true; };
      await client._isInternetAvailable(true);
      await client._isInternetAvailable();
      expect(asked).to.eql([true, false]);
    });
  });

  describe('proxy clients', () => {
    it('should keep their own check instead of the ping stage', () => {
      for (const c of [GostDockerClient, HysteriaDockerClient])
        expect(c.prototype._checkInternetAvailability).to.not.equal(VPNClient.prototype._checkInternetAvailability);
    });

    it('should pass the curl check when any test address answers', async() => {
      for (const c of [GostDockerClient, HysteriaDockerClient]) {
        const client = Object.create(c.prototype);
        const calls = [];
        const timeouts = [];
        client._execWithClientMark = async(args, options) => {
          calls.push(args.join(' '));
          timeouts.push(options.timeout);
          if (calls.length < 3)
            throw new Error('curl failed');
        };
        expect(await client._checkInternetAvailability()).to.equal(true);
        expect(calls).to.eql([
          'curl -m 5 -s -o /dev/null https://1.1.1.1',
          'curl -m 5 -s -o /dev/null https://8.8.8.8',
          'curl -m 5 -s -o /dev/null https://9.9.9.9'
        ]);
        expect(timeouts).to.eql([10000, 10000, 10000]);
      }
    });

    it('should fail the curl check when no test address answers', async() => {
      const client = Object.create(GostDockerClient.prototype);
      client._execWithClientMark = async() => { throw new Error('curl failed'); };
      expect(await client._checkInternetAvailability()).to.equal(false);
    });
  });
});

describe('Test virtual wan group members', function() {
  this.timeout(3000);

  it('should tell whether a vpn client is a member of a group', () => {
    const group = new VirtWanGroup({
      uuid: '00000000-0000-4000-8000-000000000001', name: 'test', type: 'primary_standby',
      wans: [{ profileId: 'internet', seq: 0 }, { profileId: 'direct', seq: 1 }]
    });
    try {
      expect(VirtWanGroup.hasMember('direct')).to.equal(true);
      expect(VirtWanGroup.hasMember('internet')).to.equal(true);
      expect(VirtWanGroup.hasMember('other')).to.equal(false);
    } finally {
      group.wans = []; // the instance stays registered, there is no environment to destroy here
    }
    expect(VirtWanGroup.hasMember('direct')).to.equal(false);
  });
});

// a member is ready when its tunnel is up and the internet works behind it
describe('Test virtual wan group link state', function() {
  this.timeout(3000);

  const rclient = require('../util/redis_manager.js').getRedisClient();
  before(() => {
    rclient.existsAsync = async() => true; // the group is still there, what it would save to redis goes nowhere
    rclient.hsetAsync = async() => 1;
  });
  after(() => {
    delete rclient.existsAsync;
    delete rclient.hsetAsync;
  });

  // primary A (seq 0) and standby B (seq 1), both ready, A active unless said otherwise
  function newGroup(props = {}, ready = { A: true, B: true }, active = 'A') {
    const group = Object.create(VirtWanGroup.prototype);
    Object.assign(group, { uuid: 'test', type: 'primary_standby', failback: true, refreshes: 0, alarms: [] }, props);
    group.connState = {};
    ['A', 'B'].forEach((profileId, seq) => group.connState[profileId] = { profileId, seq, enabled: true, ready: ready[profileId], active: profileId === active });
    group.refreshRT = async() => group.refreshes++;
    group._memberRoutesMissing = async() => false;
    // [member, whether the active wan switched]
    group.generateConnChangeAlarm = async(e, wanSwitched) => group.alarms.push([e.profileId, wanSwitched]);
    return group;
  }
  const state = (profileId, link, internet, extra) => Object.assign({ type: 'link_state_change', profileId, link, internet }, extra);
  const readyOf = (group) => [group.connState.A.ready, group.connState.B.ready];

  it('should take a member without internet as not ready, and fail over', async() => {
    const group = newGroup();
    await group.processLinkStateEvent(state('A', true, false));
    expect(readyOf(group)).to.eql([false, true]);
    expect(group.refreshes).to.equal(1);
    expect(group.alarms).to.eql([['A', true]]);
  });

  it('should take a broken link as not ready too', async() => {
    const group = newGroup();
    await group.processLinkStateEvent(state('A', false, false));
    expect(readyOf(group)).to.eql([false, true]);
    expect(group.refreshes).to.equal(1);
    expect(group.alarms).to.eql([['A', true]]);
  });

  it('should only alarm for a standby that loses its internet', async() => {
    const group = newGroup();
    await group.processLinkStateEvent(state('B', true, false));
    expect(readyOf(group)).to.eql([true, false]);
    expect(group.refreshes).to.equal(0);
    expect(group.alarms).to.eql([['B', false]]);
  });

  it('should not switch a group of a single member', async() => {
    const group = newGroup({ type: 'single' });
    await group.processLinkStateEvent(state('A', true, false));
    expect(readyOf(group)).to.eql([false, true]);
    expect(group.refreshes).to.equal(0);
    expect(group.alarms).to.eql([['A', false]]);
  });

  it('should leave a member that is not ready alone', async() => {
    const group = newGroup({}, { A: false, B: true }, 'B');
    await group.processLinkStateEvent(state('A', true, false));
    expect(readyOf(group)).to.eql([false, true]);
    expect(group.refreshes).to.equal(0);
    expect(group.alarms).to.eql([]);
  });

  it('should fail back when the primary has its internet again', async() => {
    const group = newGroup({}, { A: false, B: true }, 'B');
    await group.processLinkStateEvent(state('A', true, true));
    expect(readyOf(group)).to.eql([true, true]);
    expect(group.refreshes).to.equal(1);
    expect(group.alarms).to.eql([['A', true]]);
  });

  it('should not switch back to a primary that recovers when failback is off', async() => {
    const group = newGroup({ failback: false }, { A: false, B: true }, 'B');
    await group.processLinkStateEvent(state('A', true, true));
    expect(readyOf(group)).to.eql([true, true]);
    expect(group.refreshes).to.equal(0);
    expect(group.alarms).to.eql([['A', false]]);
  });

  it('should refresh the routes after a route update of a member that is ready', async() => {
    const group = newGroup();
    await group.processLinkStateEvent(state('B', true, true, { routeUpdated: true }));
    expect(readyOf(group)).to.eql([true, true]);
    expect(group.refreshes).to.equal(1);
    expect(group.alarms).to.eql([]);
  });
});
