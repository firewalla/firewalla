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
    client._setCachedState = async(state) => cachedStates.push(state);

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
  client._setCachedState = async() => {};
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

  // runs one check per verdict, returns the event types each of them emitted
  async function run(client, verdicts) {
    const rounds = [];
    for (const verdict of verdicts) {
      client._isInternetAvailable = async() => verdict;
      emitted.length = 0;
      await client._checkConnectivity();
      rounds.push(emitted.map(e => e.internet === undefined ? e.type : `${e.type}:${e.internet}`).join());
    }
    return rounds;
  }

  it('should start with 0 failures and 1 success short of recovery', () => {
    const client = newStubClient();
    expect(client.internetFailureCount).to.equal(0);
    expect(client.internetSuccessCount).to.equal(4);
    expect(client.internetUnknownCount).to.equal(0);
    client.internetFailureCount = 3;
    client.internetSuccessCount = 0;
    client.internetUnknownCount = 2;
    client._resetInternetCounters();
    expect(client.internetFailureCount).to.equal(0);
    expect(client.internetSuccessCount).to.equal(4);
    expect(client.internetUnknownCount).to.equal(0);
  });

  it('should promote on the first good sample after a reset', async() => {
    expect(await run(newStubClient(), [true])).to.eql(['link_established']);
  });

  it('should need 2 consecutive failures after a reset', async() => {
    expect(await run(newStubClient(), [false])).to.eql(['']);
    expect(await run(newStubClient(), [false, false])).to.eql(['', 'link_broken:true']);
    // a failure spends the head start of the first good sample
    expect(await run(newStubClient(), [false, true, true, true, true])).to.eql(['', '', '', '', '']);
  });

  it('should break on the 2nd failure and recover on the 5th success', async() => {
    const client = newStubClient();
    expect(await run(client, [true, false, false, true, true, true, true, true])).to.eql([
      'link_established', '', 'link_broken:true', '', '', '', '', 'link_established'
    ]);
  });

  it('should restart the success count on a failure while recovering', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    expect(await run(client, [true, true, true, true, false, true, true, true, true, true])).to.eql([
      '', '', '', '', '', '', '', '', '', 'link_established'
    ]);
  });

  it('should not count a sample that could not tell', async() => {
    expect(await run(newStubClient(), [false, null])).to.eql(['', '']);
    expect(await run(newStubClient(), [false, null, false])).to.eql(['', '', 'link_broken:true']);
  });

  it('should fall back to the link-only verdict after 5 samples that could not tell', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    expect(await run(client, [null, null, null, null, null])).to.eql([
      'link_broken:true', 'link_broken:true', 'link_broken:true', 'link_broken:true', 'link_established'
    ]);
    expect(client.internetUnknownCount).to.equal(5);
  });

  it('should count samples that could not tell only while they are consecutive', async() => {
    const client = newStubClient();
    await run(client, [true, false, false]);
    const rounds = await run(client, [null, null, null, null, false, null, null, null, null]);
    expect(rounds.filter(r => r === 'link_established')).to.eql([]);
    expect(client.internetUnknownCount).to.equal(4);
  });

  it('should report a broken link without the internet flag and without probing', async() => {
    const client = newStubClient();
    client._isLinkUp = async() => false;
    client._isInternetAvailable = async() => { throw new Error('should not probe'); };
    await client._checkConnectivity();
    expect(emitted.map(e => [e.type, e.internet])).to.eql([['link_broken', false]]);
  });

  it('should not probe a client that does not override the default route', async() => {
    const client = newStubClient({ overrideDefaultRoute: false });
    client._isInternetAvailable = async() => { throw new Error('should not probe'); };
    await client._checkConnectivity();
    expect(emitted.map(e => e.type)).to.eql(['link_established']);
  });

  it('should discard a sample that finishes after the client is stopped', async() => {
    const client = newStubClient();
    client._isInternetAvailable = async() => { client._started = false; return false; };
    await client._checkConnectivity();
    await client._checkConnectivity();
    expect(emitted).to.eql([]);
  });
});

describe('Test vpnClient link_broken listener', function() {
  this.timeout(3000);

  const events = ['link_broken', 'link_established', 'link_wan_switched'];
  let listeners;
  afterEach(() => listeners.remove());

  function hook(client, autoReconnect) {
    client._currentState = false; // skips the ipset flush and alarm, which need a box
    client._autoReconnectNeeded = async() => autoReconnect;
    client.restarts = 0;
    client.scheduleRestart = () => client.restarts++;
    listeners = captureListeners(events, () => client.hookLinkStateChange());
    return listeners.added.link_broken[0];
  }

  it('should not restart the tunnel for a loss of internet', async() => {
    const client = newStubClient();
    const onBroken = hook(client, true);
    await onBroken({ type: 'link_broken', profileId: client.profileId, internet: true });
    expect(client.restarts).to.equal(0);
    expect(client._currentState).to.equal(false);
  });

  it('should restart the tunnel for a broken link', async() => {
    const client = newStubClient();
    const onBroken = hook(client, true);
    await onBroken({ type: 'link_broken', profileId: client.profileId, internet: false });
    await onBroken({ type: 'link_broken', profileId: client.profileId });
    expect(client.restarts).to.equal(2);
  });

  it('should not restart a broken link when autoReconnect is off', async() => {
    const client = newStubClient();
    const onBroken = hook(client, false);
    await onBroken({ type: 'link_broken', profileId: client.profileId, internet: false });
    expect(client.restarts).to.equal(0);
  });

  it('should ignore events of other clients', async() => {
    const client = newStubClient();
    const onBroken = hook(client, true);
    await onBroken({ type: 'link_broken', profileId: `${client.profileId}_other`, internet: false });
    expect(client.restarts).to.equal(0);
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
    expect([client.internetFailureCount, client.internetSuccessCount, client.internetUnknownCount]).to.eql([0, 4, 0]);
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
        client._execWithClientMark = async(args) => {
          calls.push(args.join(' '));
          if (calls.length < 3)
            throw new Error('curl failed');
        };
        expect(await client._checkInternetAvailability()).to.equal(true);
        expect(calls).to.eql([
          'curl -m 5 -s -o /dev/null https://1.1.1.1',
          'curl -m 5 -s -o /dev/null https://8.8.8.8',
          'curl -m 5 -s -o /dev/null https://9.9.9.9'
        ]);
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

  const clients = {};
  let origGetInstance;
  before(() => {
    origGetInstance = VPNClient.getInstance;
    VPNClient.getInstance = (profileId) => clients[profileId] || null;
    for (const [profileId, overrideDefaultRoute] of [['direct', false], ['internet', true], ['internet2', true]])
      clients[profileId] = { loadSettings: async() => ({ overrideDefaultRoute }) };
  });
  after(() => {
    VPNClient.getInstance = origGetInstance;
  });

  it('should find the members that do not override the default route', async() => {
    const wans = [{ profileId: 'internet', seq: 0 }, { profileId: 'direct', seq: 1 }, { profileId: 'unknown', seq: 2 }];
    expect(await VirtWanGroup.getDirectMembers(wans)).to.eql(['direct']);
    expect(await VirtWanGroup.getDirectMembers([wans[0], wans[2]])).to.eql([]);
  });

  it('should reject a group with such a member with 400, before anything is written', async() => {
    let error;
    await virtWanGroupManager.createOrUpdateVirtWanGroup({
      name: 'test', type: 'primary_standby', wans: [{ profileId: 'internet2', seq: 0 }, { profileId: 'direct', seq: 1 }]
    }).catch(err => error = err);
    expect(error).to.include({ code: 400 });
    expect(error.msg).to.contain('direct');
  });
});
