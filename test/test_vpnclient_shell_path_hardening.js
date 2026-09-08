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
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();
const applianceStubs = require('./helpers/vpnclient_appliance_stubs.js');

function installVPNClientStubs() {
  const state = {
    execCalls: [],
    execFileCalls: [],
    destroyRtIdCalls: [],
    strictVPNRemovals: 0,
    cacheWrites: [],
    cachedState: null,
    execFileResponder: (binary, args) => {
      if (binary === 'ip' && args[0] === '-o')
        return Promise.resolve({ stdout: '' });
      return Promise.reject(Object.assign(new Error('ip link not found'), {
        code: 1, stderr: 'Cannot find device'
      }));
    }
  };

  const VPNClient = proxyquire('../extension/vpnclient/VPNClient.js', {
    ...applianceStubs(),
    '../../net2/Firewalla.js': { isMain: () => false },
    '../../util/redis_manager.js': {
      getSubscriptionClient: () => ({ on: () => {} }),
      rclient: {
        getAsync: () => Promise.resolve(state.cachedState),
        setAsync: async (key, value) => {
          if (value === true && state.failCacheWrite)
            throw new Error('cache write failed');
          state.cacheWrites.push(value);
          state.cachedState = String(value);
        },
        expireAsync: async () => {
          if (state.cachedState === 'true' && state.failCacheExpiry)
            throw new Error('cache expiry failed');
        },
        unlinkAsync: async (key) => {
          if (key.endsWith(':connState'))
            state.cachedState = null;
        },
        delAsync: () => Promise.resolve()
      }
    },
    'child-process-promise': {
      exec: (...args) => {
        state.execCalls.push(args);
        return Promise.reject(new Error('shell execution was not expected'));
      },
      execFile: (...args) => {
        state.execFileCalls.push(args);
        return state.execFileResponder(...args);
      }
    },
    '../../net2/Iptables.js': {
      Rule: class {
        chn() { return this; }
        set() { return this; }
        jmp() { return this; }
        opr() { return this; }
        fam() { return this; }
        oif() { return this; }
        iif() { return this; }
      }
    },
    '../../control/IptablesControl.js': { addRule: async () => {} },
    '../../net2/Ipset.js': { flush: async () => {} },
    '../dnsmasq/dnsmasq.js': class { scheduleRestartDNSService() {} },
    './VPNClientEnforcer.js': {
      flushVPNClientRoutes: async () => {},
      removeVPNClientIPRules: async () => {},
      unenforceStrictVPN: async () => { state.strictVPNRemovals++; },
      destroyRtId: (...args) => {
        state.destroyRtIdCalls.push(args);
        return Promise.resolve();
      }
    }
  });

  return { VPNClient, state };
}

describe('VPNClient shell and path hardening', function () {
  it('enforces the profileId format at the VPNClient boundary', () => {
    const { VPNClient } = installVPNClientStubs();
    class TestVPNClient extends VPNClient {}

    expect(() => VPNClient.validateProfileId('valid_123')).to.not.throw();
    expect(() => new TestVPNClient({ profileId: 'valid_123' })).to.not.throw();
    expect(() => new TestVPNClient({ profileId: '../escape' })).to.throw(/profileId/);
    expect(() => new TestVPNClient({ profileId: 'bad-name' })).to.throw(/profileId/);
    expect(() => VPNClient.validateProfileId('12345678901')).to.not.throw();
    const longestClient = new TestVPNClient({ profileId: '12345678901' });
    expect(longestClient.getInterfaceName()).to.equal('vpn_12345678901');
    expect(longestClient.getInterfaceName().length).to.equal(15);
    expect(() => new TestVPNClient({ profileId: '123456789012' })).to.throw(/11 characters/);
    expect(() => VPNClient.validateProfileId('valid_123\n')).to.throw();
    expect(() => VPNClient.validateProfileId('$(touch /tmp/pwn)')).to.throw();
    expect(() => VPNClient.validateProfileId(123)).to.throw();
  });

  it('initializes legacy clients while bypassing only profileId validation', () => {
    const { VPNClient } = installVPNClientStubs();
    class TestVPNClient extends VPNClient {
      constructor(options) {
        super(options);
        this.initialized = true;
      }
    }

    const client = VPNClient.createLegacyClient(TestVPNClient, 'legacy-profile');
    expect(client.profileId).to.equal('legacy-profile');
    expect(client.initialized).to.equal(true);

    const cachedClient = VPNClient.createLegacyClient(TestVPNClient, 'legacy-profile');
    expect(cachedClient).to.equal(client);
  });

  it('retains invalid stored profile IDs as sanitized initialization metadata', async () => {
    const { VPNClient } = installVPNClientStubs();
    class TestVPNClient extends VPNClient {
      static getProtocol() {
        return 'openvpn';
      }

      static async listProfileIds() {
        return ['valid_123', 'legacy-profile'];
      }
      static getKeyNameForInit() {
        return 'testVpnProfiles';
      }
      async getAttributes() {
        return { profileId: this.profileId };
      }
    }
    const originalGetClass = VPNClient.getClass;
    VPNClient.getClass = (type) => type === 'openvpn' ? TestVPNClient : null;
    try {
      expect(await VPNClient.getVPNProfilesForInit()).to.eql({
        testVpnProfiles: [
          { profileId: 'valid_123' },
          {
            profileId: 'legacy-profile',
            type: 'openvpn',
            invalidProfileId: true,
            message: 'This VPN profile has an invalid ID and requires administrator remediation.'
          }
        ]
      });
    } finally {
      VPNClient.getClass = originalGetClass;
    }
  });

  it('deletes the protocol-specific primary stored profile artifact', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vpnclient-'));
    const profileId = 'legacy_profile';
    class TestVPNClient extends VPNClient {
      static getConfigDirectory() { return configDirectory; }
      static getStoredProfileArtifacts(id) {
        return super.getStoredProfileArtifacts(id).concat({
          root: configDirectory,
          path: `${id}.ovpn`
        });
      }
      static getPrimaryProfilePath(id) { return path.join(configDirectory, `${id}.ovpn`); }
    }
    try {
      for (const suffix of ['.settings', '.json', '.endpoint_routes', '.ovpn'])
        await fs.writeFile(path.join(configDirectory, `${profileId}${suffix}`), 'test');
      await TestVPNClient.destroyStoredProfile(profileId);
      expect(state.destroyRtIdCalls).to.eql([['vpn_' + profileId]]);
      for (const suffix of ['.settings', '.json', '.endpoint_routes', '.ovpn'])
        expect(await fs.access(path.join(configDirectory, `${profileId}${suffix}`)).then(() => true).catch(() => false)).to.equal(false);
    } finally {
      await fs.rm(configDirectory, { recursive: true, force: true });
    }
  });

  it('preserves profile discovery after partial artifact deletion and completes on retry', async () => {
    const { VPNClient } = installVPNClientStubs();
    const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vpnclient-retry-'));
    const profileId = 'legacy-profile';
    class TestVPNClient extends VPNClient {
      static getConfigDirectory() { return configDirectory; }
      static getStoredProfileArtifacts(id) {
        return super.getStoredProfileArtifacts(id).concat({ root: configDirectory, path: `${id}.ovpn` });
      }
    }
    const artifact = suffix => path.join(configDirectory, `${profileId}${suffix}`);
    try {
      for (const suffix of ['.settings', '.json', '.ovpn'])
        await fs.writeFile(artifact(suffix), 'test');
      // unlink cannot remove a directory, so fail after .json was removed.
      await fs.mkdir(artifact('.endpoint_routes'));
      const error = await TestVPNClient.destroyStoredProfile(profileId).then(() => null, err => err);
      expect(error).to.be.instanceOf(Error);
      expect(['EISDIR', 'EPERM']).to.include(error.code);
      expect(await fs.access(artifact('.json')).then(() => true, () => false)).to.equal(false);
      expect(await fs.readFile(artifact('.ovpn'), 'utf8')).to.equal('test');
      expect(await fs.readFile(artifact('.settings'), 'utf8')).to.equal('test');
      expect(await TestVPNClient.listProfileIds()).to.eql([profileId]);
      expect(await TestVPNClient.profileExists(profileId)).to.equal(true);

      // Correct the failing artifact and retry with the first artifact absent.
      await fs.rmdir(artifact('.endpoint_routes'));
      await fs.writeFile(artifact('.endpoint_routes'), 'test');
      await TestVPNClient.destroyStoredProfile(profileId);
      expect(await fs.readdir(configDirectory)).to.eql([]);
      expect(await TestVPNClient.profileExists(profileId)).to.equal(false);
    } finally {
      await fs.rm(configDirectory, { recursive: true, force: true });
    }
  });

  it('treats transitional systemd states as active and unknown states as indeterminate', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    class TestVPNClient extends VPNClient {
      static getRuntimeServiceName() { return 'test-vpn.service'; }
    }
    for (const [status, expected] of [
      ['active', true], ['activating', true], ['reloading', true], ['deactivating', true],
      ['inactive', false], ['failed', false], ['unknown', null], ['', null]
    ]) {
      // systemctl can report a state through stdout even with a nonzero exit.
      for (const rejected of [false, true]) {
        state.execFileResponder = () => rejected
          ? Promise.reject(Object.assign(new Error('systemctl status'), { stdout: status, code: 3 }))
          : Promise.resolve({ stdout: status });
        expect(await TestVPNClient.getRuntimeActive('legacy-profile')).to.equal(expected);
      }
    }
  });

  it('serializes stop and stored-profile destruction on the same lifecycle lock', async () => {
    const { VPNClient } = installVPNClientStubs();
    const client = Object.create(VPNClient.prototype);
    client.profileId = 'valid_123';

    let releaseStop;
    const stopEntered = new Promise((resolve) => {
      client._stopWithoutLifecycleLock = async () => {
        resolve();
        await new Promise((release) => { releaseStop = release; });
      };
    });

    const stopPromise = client.stop();
    await stopEntered;
    let destroyEntered = false;
    const stopAfterLock = new Error('lock acquisition observed; skip artifact cleanup');
    const destroyPromise = VPNClient.destroyStoredProfile('valid_123', async () => {
      destroyEntered = true;
      throw stopAfterLock;
    }).catch(err => { expect(err).to.equal(stopAfterLock); });
    await Promise.resolve();
    expect(destroyEntered).to.equal(false);

    releaseStop();
    await Promise.all([stopPromise, destroyPromise]);
    expect(destroyEntered).to.equal(true);
  });

  it('allows stop to cancel a client that never establishes a tunnel', async () => {
    const { VPNClient } = installVPNClientStubs();
    const client = Object.create(VPNClient.prototype);
    client.profileId = 'valid_123';
    client._prepareRoutes = async () => {};
    client.flushRemoteEndpointRoutes = async () => {};
    client._start = async () => {};
    client._isLinkUp = async () => false;
    client.getMessage = async () => null;
    client._stopWithoutLifecycleLock = async () => {
      client._started = false;
    };

    const startPromise = client.start();
    const stopPromise = client.stop();
    const stopResult = await Promise.race([
      stopPromise.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 100))
    ]);

    expect(stopResult).to.equal('stopped');
    expect(await startPromise).to.include({ result: false, cancelled: true });
  });

  it('does not schedule establishment polling after stop cancels a pending initial link check', async () => {
    const { VPNClient } = installVPNClientStubs();
    const client = Object.create(VPNClient.prototype);
    client.profileId = 'valid_123';
    client._prepareRoutes = async () => {};
    client.flushRemoteEndpointRoutes = async () => {};
    client._start = async () => {};
    client._stopWithoutLifecycleLock = async () => {
      client._started = false;
    };

    let releaseLinkCheck;
    const linkCheckStarted = new Promise((resolve) => {
      client._isLinkUp = async () => {
        resolve();
        await new Promise((release) => {
          releaseLinkCheck = release;
        });
        return false;
      };
    });
    const originalSetInterval = global.setInterval;
    let intervalCreated = false;
    global.setInterval = (...args) => {
      intervalCreated = true;
      return originalSetInterval(...args);
    };

    try {
      const startPromise = client.start();
      await linkCheckStarted;
      await client.stop();
      releaseLinkCheck();

      expect(await startPromise).to.include({ result: false, cancelled: true });
      expect(intervalCreated).to.equal(false);
    } finally {
      global.setInterval = originalSetInterval;
    }
  });

  for (const cancel of [false, true]) {
    it(`handles overlapping successful link checks ${cancel ? 'while stop cancels finalization' : 'without cancelling startup'}`, async () => {
      const { VPNClient } = installVPNClientStubs();
      const client = Object.create(VPNClient.prototype);
      client.profileId = 'valid_123';
      client._prepareRoutes = async () => {};
      client.flushRemoteEndpointRoutes = async () => {};
      client._start = async () => {};
      client._setCachedState = async () => {};
      client._stopWithoutLifecycleLock = async () => { client._started = false; };
      let refreshes = 0;
      let routeCalls = 0;
      client._scheduleRefreshRoutes = () => { refreshes++; };
      let releaseRoutes;
      const routesBlocked = new Promise(resolve => { releaseRoutes = resolve; });
      let routesEntered;
      const installingRoutes = new Promise(resolve => { routesEntered = resolve; });
      client.addRemoteEndpointRoutes = async () => {
        routeCalls++;
        routesEntered();
        await routesBlocked;
      };
      const linkChecks = [];
      let initialCheck = true;
      client._isLinkUp = () => {
        if (initialCheck) {
          initialCheck = false;
          return Promise.resolve(false);
        }
        return new Promise(resolve => { linkChecks.push(resolve); });
      };

      const originalSetTimeout = global.setTimeout;
      const originalSetInterval = global.setInterval;
      let initialCallback;
      let poll;
      let timerScheduled;
      const scheduled = new Promise(resolve => { timerScheduled = resolve; });
      global.setTimeout = (callback, delay, ...args) => {
        if (delay !== 500)
          return originalSetTimeout(callback, delay, ...args);
        initialCallback = callback;
        timerScheduled();
        return null;
      };
      global.setInterval = (callback, delay) => {
        expect(delay).to.equal(2000);
        poll = callback;
        return null;
      };

      let startPromise;
      let firstPoll;
      let secondPoll;
      try {
        startPromise = client.start();
        await scheduled;
        await initialCallback();
        // Simulate two interval ticks before either asynchronous check finishes.
        firstPoll = poll();
        secondPoll = poll();
        expect(linkChecks.length).to.equal(2);
        linkChecks[0](true);
        await installingRoutes;
        linkChecks[1](true);
        await secondPoll;
        if (cancel) {
          const stopPromise = client.stop();
          releaseRoutes();
          await stopPromise;
        } else {
          releaseRoutes();
        }
        await firstPoll;
        expect(await startPromise).to.eql(cancel ? { result: false, cancelled: true } : { result: true });
        expect(routeCalls).to.equal(1);
        expect(refreshes).to.equal(cancel ? 0 : 1);
        expect(client._establishment).to.equal(null);
      } finally {
        client._cancelEstablishment();
        linkChecks.forEach(resolve => resolve(true));
        releaseRoutes();
        await Promise.all([firstPoll, secondPoll, startPromise]);
        global.setTimeout = originalSetTimeout;
        global.setInterval = originalSetInterval;
      }
    });
  }

  for (const failure of ['cache write', 'cache expiry', 'route scheduling', 'cleanup']) {
    it(`cleans up failed startup finalization and retries after ${failure} failure`, async function () {
      this.timeout(5000);
      const { VPNClient, state } = installVPNClientStubs();
      const client = Object.create(VPNClient.prototype);
      client.profileId = 'retry_test';
      let starts = 0;
      let stops = 0;
      let failScheduling = failure === 'route scheduling';
      let failCleanup = failure === 'cleanup';
      state.failCacheWrite = failure === 'cache write';
      state.failCacheExpiry = failure === 'cache expiry' || failure === 'cleanup';
      client._prepareRoutes = async () => {};
      client.flushRemoteEndpointRoutes = async () => {};
      client._start = async () => { starts++; };
      client._isLinkUp = async () => true;
      client.addRemoteEndpointRoutes = async () => {};
      client._scheduleRefreshRoutes = () => {
        if (failScheduling)
          throw new Error('route scheduling failed');
      };
      client._stopWithoutLifecycleLock = async () => {
        stops++;
        if (failCleanup)
          throw new Error('cleanup failed');
        client._started = false;
        await client._setCachedState(false);
      };

      const firstStart = client.start();
      expect(client.start()).to.equal(firstStart);
      const result = await firstStart;
      expect(result.result).to.equal(false);
      expect(result.errMsg).to.equal(failure === 'cleanup' ? 'cache expiry failed' : `${failure} failed`);
      expect(stops).to.equal(1);
      expect(client._startPromise).to.equal(null);
      expect(client._establishment).to.equal(null);
      if (failCleanup) {
        // Do not claim inactivity if resource cleanup failed. Invalidate the
        // success cache and prevent another launch until cleanup succeeds.
        expect(state.cachedState).to.equal(null);
        const error = await client.start().then(() => null, err => err);
        expect(error.message).to.equal('cleanup failed');
        expect(starts).to.equal(1);
        failCleanup = false;
      } else {
        expect(client.isStarted()).to.equal(false);
        expect(state.cachedState).to.equal('false');
      }

      state.failCacheWrite = false;
      state.failCacheExpiry = false;
      failScheduling = false;
      expect(await client.start()).to.eql({ result: true });
      expect(starts).to.equal(2);
      expect(client.isStarted()).to.equal(true);
      expect(state.cachedState).to.equal('true');
    });
  }

  for (const [implementation, failedStartup] of [
    ['stub', true], ['stub', false], ['openvpn', true], ['openvpn', false]
  ]) {
    it(`${implementation}: ${failedStartup ? 'blocks startup retries' : 'preserves ordinary stop behavior'} when the service stop rejects`, async function () {
      this.timeout(5000);
      const { VPNClient, state } = installVPNClientStubs();
      const client = Object.create(VPNClient.prototype);
      client.profileId = 'stop_retry';
      const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vpn-stop-'));
      const originalEnsureEnv = VPNClient.ensureCreateEnforcementEnv;
      VPNClient.ensureCreateEnforcementEnv = async () => {};
      let starts = 0;
      let stops = 0;
      let failStop = true;
      const stopError = new Error('service stop failed');
      client._prepareRoutes = async () => {};
      client.flushRemoteEndpointRoutes = async () => {};
      client._start = async () => { starts++; };
      client._isLinkUp = async () => true;
      client.addRemoteEndpointRoutes = async () => {};
      client._scheduleRefreshRoutes = () => {};
      client.loadSettings = async () => {};
      client._getDNSServers = async () => [];
      client._getDnsmasqConfigPath = () => path.join(configDirectory, 'vpn.conf');
      client._disableDNSRoute = async () => {};
      client._disablePBRDNSRoute = async () => {};
      const rejectStop = async () => {
        stops++;
        if (failStop)
          throw stopError;
      };
      if (implementation === 'openvpn') {
        const OpenVPNClient = proxyquire('../extension/vpnclient/OpenVPNClient.js', {
          ...applianceStubs(),
          '../../net2/Firewalla.js': {},
          './VPNClient.js': VPNClient,
          'child-process-promise': {
            execFile: async (binary, args) => {
              expect(binary).to.equal('sudo');
              expect(args[0]).to.equal('systemctl');
              expect(args[2]).to.equal('openvpn_client@stop_retry');
              if (args[1] === 'stop')
                return rejectStop();
              expect(args[1]).to.equal('disable');
            }
          }
        });
        // Exercise the real protocol method beneath the real stop wrapper.
        client._stop = OpenVPNClient.prototype._stop;
      } else {
        client._stop = rejectStop;
      }
      try {
        if (!failedStartup) {
          await client.stop();
          expect(stops).to.equal(1);
          expect(state.strictVPNRemovals).to.equal(1);
          expect(state.cachedState).to.equal('false');
          return;
        }
        // Exercise the real stop wrapper after SET succeeds and EXPIRE fails.
        state.failCacheExpiry = true;
        expect(await client.start()).to.eql({ result: false, errMsg: 'cache expiry failed' });
        expect(stops).to.equal(1);
        expect(client._startupCleanupRequired).to.equal(true);
        expect(state.cachedState).to.equal(null);
        expect(state.cacheWrites).to.eql([true]);
        expect(state.strictVPNRemovals).to.equal(0);

        state.failCacheExpiry = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = await client.start().then(() => null, err => err);
          expect(error).to.equal(stopError);
          expect(starts).to.equal(1);
          expect(client._startupCleanupRequired).to.equal(true);
          expect(state.cachedState).to.equal(null);
          expect(state.cacheWrites).to.eql([true]);
          expect(state.strictVPNRemovals).to.equal(0);
        }
        expect(stops).to.equal(3);

        failStop = false;
        expect(await client.start()).to.eql({ result: true });
        expect(stops).to.equal(4);
        expect(starts).to.equal(2);
        expect(client._startupCleanupRequired).to.equal(false);
        expect(state.strictVPNRemovals).to.equal(1);
        expect(state.cacheWrites).to.eql([true, false, true]);
        expect(state.cachedState).to.equal('true');
      } finally {
        client._cancelEstablishment();
        VPNClient.ensureCreateEnforcementEnv = originalEnsureEnv;
        await fs.rm(configDirectory, { recursive: true, force: true });
      }
    });
  }

  it('does not clean up a newer start after a cancelled finalization fails', async function () {
    this.timeout(5000);
    const { VPNClient } = installVPNClientStubs();
    const client = Object.create(VPNClient.prototype);
    client.profileId = 'retry_race';
    let stops = 0;
    let starts = 0;
    let cacheEntered;
    let rejectCache;
    const entered = new Promise(resolve => { cacheEntered = resolve; });
    const blocked = new Promise((resolve, reject) => { rejectCache = reject; });
    client._prepareRoutes = async () => {};
    client.flushRemoteEndpointRoutes = async () => {};
    client._start = async () => { starts++; };
    client._isLinkUp = async () => true;
    client.addRemoteEndpointRoutes = async () => {};
    client._scheduleRefreshRoutes = () => {};
    client._setCachedState = async () => {
      if (starts === 1) {
        cacheEntered();
        await blocked;
      }
    };
    client._stopWithoutLifecycleLock = async () => { stops++; client._started = false; };
    const first = client.start();
    await entered;
    const stop = client.stop();
    expect(await first).to.eql({ result: false, cancelled: true });
    const retry = client.start();
    rejectCache(new Error('old finalization failed'));
    await stop;
    expect(await retry).to.eql({ result: true });
    expect(starts).to.equal(2);
    expect(stops).to.equal(1);
    expect(client.isStarted()).to.equal(true);
  });

  it('detects an active legacy profile with the historical 15-character interface name', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = (binary, args) => {
      if (args[0] === '-o' && args[1] === 'link' && args[2] === 'show')
        return Promise.resolve({ stdout: '1: lo: <LOOPBACK>\n2: vpn_legacy-prof: <POINTOPOINT>\n' });
      return Promise.reject(Object.assign(new Error('unexpected invocation'), { code: 1 }));
    };

    expect(await VPNClient.isProfileActive('legacy-profile')).to.equal(true);
    expect(state.execFileCalls[0][1]).to.eql(['-o', 'link', 'show']);
  });

  it('detects an active legacy profile when the exact long derived interface name is present', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = (binary, args) => {
      if (args[0] === '-o' && args[1] === 'link' && args[2] === 'show')
        return Promise.resolve({ stdout: '1: lo: <LOOPBACK>\n2: vpn_legacy-profile: <POINTOPOINT>\n' });
      return Promise.reject(Object.assign(new Error('unexpected invocation'), { code: 1 }));
    };

    expect(await VPNClient.isProfileActive('legacy-profile')).to.equal(true);
  });

  it('detects an inactive legacy profile when neither long nor historical interface is present', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = (binary, args) => {
      if (args[0] === '-o' && args[1] === 'link' && args[2] === 'show')
        return Promise.resolve({ stdout: '1: lo: <LOOPBACK>\n2: eth0: <BROADCAST>\n' });
      return Promise.reject(Object.assign(new Error('unexpected invocation'), { code: 1 }));
    };

    expect(await VPNClient.isProfileActive('legacy-profile')).to.equal(false);
  });

  it('falls back to interface inspection when runtime activity is indeterminate', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.execFileResponder = (binary, args) => {
      if (args[0] === 'link' && args[1] === 'show')
        return Promise.resolve({ stdout: '2: vpn_legacy-profile: <POINTOPOINT>\n' });
      return Promise.reject(Object.assign(new Error('unexpected invocation'), { code: 1 }));
    };
    class ClientWithoutRuntimeService extends VPNClient {
      static async getRuntimeActive() {
        return null;
      }
    }

    expect(await VPNClient.isProfileActive('short_id', ClientWithoutRuntimeService)).to.equal(true);
    expect(state.execFileCalls).to.have.lengthOf(1);
  });

  it('returns null for non-absence errors from a directly queryable interface', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = () => Promise.reject(Object.assign(new Error('permission denied'), { code: 2 }));

    expect(await VPNClient.isProfileActive('short_id')).to.equal(null);
  });

  it('returns null for unrelated code-1 errors from a directly queryable interface', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = () => Promise.reject(Object.assign(new Error('netlink failure'), {
      code: 1,
      stderr: 'RTNETLINK answers: Operation not permitted\n'
    }));

    expect(await VPNClient.isProfileActive('short_id')).to.equal(null);
  });

  it('returns false when ip reports that a directly queryable interface is absent', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = () => Promise.reject(Object.assign(new Error('device absent'), {
      code: 1,
      stderr: 'Device "vpn_short_id" does not exist.\n'
    }));

    expect(await VPNClient.isProfileActive('short_id')).to.equal(false);
  });

  it('treats a cached active state as active without executing a shell command', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = 'true';
    expect(await VPNClient.isProfileActive('legacy-profile')).to.equal(true);
    expect(state.execFileCalls).to.have.lengthOf(0);
  });

  it('validates DNS labels as well as the full hostname', () => {
    const { VPNClient } = installVPNClientStubs();
    const overlong = `${'a'.repeat(64)}.firewalla.com`;
    expect(VPNClient.isValidFirewallaDDNSDomain('firewalla.com')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain('box.firewalla.com')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain(overlong)).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('evilfirewalla.com')).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('$(touch /tmp/pwn).firewalla.com')).to.equal(false);
  });

  it('uses execFile with discrete arguments for DDNS lookups', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.execFileResponder = (binary, args) => {
      if (args[0] === '+time=3' && args.includes('SOA'))
        return Promise.resolve({ stdout: ';; AUTHORITY SECTION:\nfirewalla.com. 300 IN SOA ns1.firewalla.com. hostmaster.firewalla.com. 1 2 3 4 5\n;; ANSWER SECTION:\nignored.firewalla.com. 60 IN A 203.0.113.10\n' });
      if (args.includes('NS'))
        return Promise.resolve({ stdout: 'ns1.firewalla.com.\nns2.firewalla.com.\n' });
      return Promise.resolve({ stdout: '192.0.2.53\n' });
    };
    const client = Object.create(VPNClient.prototype);
    expect(await client.resolveFirewallaDDNS('box.firewalla.com')).to.equal('192.0.2.53');
    expect(state.execCalls).to.have.lengthOf(0);
    expect(state.execFileCalls[0][1]).to.eql(['+time=3', '+tries=2', 'SOA', 'box.firewalla.com']);
    expect(state.execFileCalls[1][1]).to.eql(['+time=3', '+tries=2', '+short', 'NS', 'firewalla.com.']);
  });

  for (const soaOutput of [
    ';; ANSWER SECTION:\nfirewalla.com. 60 IN A 192.0.2.1\n',
    ';; AUTHORITY SECTION:\n\n;; ANSWER SECTION:\nfirewalla.com. 60 IN A 192.0.2.1\n'
  ]) {
    it('does not query nameservers when the authority section is missing or empty', async () => {
      const { VPNClient, state } = installVPNClientStubs();
      state.execFileResponder = async () => ({ stdout: soaOutput });
      const client = Object.create(VPNClient.prototype);
      expect(await client.resolveFirewallaDDNS('box.firewalla.com')).to.equal(undefined);
      expect(state.execFileCalls).to.have.lengthOf(1);
    });
  }

  for (const firstAnswer of ['', 'not-an-address\n', '0.0.0.0\n', null]) {
    it(`tries the next authoritative server after unusable answer ${JSON.stringify(firstAnswer)}`, async () => {
      const { VPNClient, state } = installVPNClientStubs();
      state.execFileResponder = async (binary, args) => {
        expect(binary).to.equal('dig');
        if (args.includes('SOA'))
          return { stdout: ';; AUTHORITY SECTION:\nfirewalla.com. 300 IN SOA ns1.firewalla.com. hostmaster.firewalla.com. 1 2 3 4 5\n' };
        if (args.includes('NS'))
          return { stdout: 'ns1.firewalla.com.\nns2.firewalla.com.\n' };
        if (args.includes('@ns1.firewalla.com.')) {
          if (firstAnswer === null)
            throw new Error('DNS query failed');
          return { stdout: firstAnswer };
        }
        expect(args).to.eql(['+short', '+time=3', '+tries=1', '@ns2.firewalla.com.', 'A', 'box.firewalla.com']);
        return { stdout: '192.0.2.53\n' };
      };
      const client = Object.create(VPNClient.prototype);
      expect(await client.resolveFirewallaDDNS('box.firewalla.com')).to.equal('192.0.2.53');
      expect(state.execFileCalls).to.have.lengthOf(4);
      expect(state.execCalls).to.have.lengthOf(0);
    });
  }
});
