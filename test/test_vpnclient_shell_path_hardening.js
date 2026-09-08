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

function installVPNClientStubs() {
  const state = {
    execCalls: [],
    execFileCalls: [],
    destroyRtIdCalls: [],
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
    '../../net2/Firewalla.js': { isMain: () => false },
    '../../util/redis_manager.js': {
      getSubscriptionClient: () => ({ on: () => {} }),
      rclient: {
        getAsync: () => Promise.resolve(state.cachedState),
        unlinkAsync: () => Promise.resolve(),
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
    './VPNClientEnforcer.js': {
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
});
