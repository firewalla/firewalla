/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
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
    execFileResponder: () => Promise.reject(Object.assign(new Error('ip link not found'), { code: 1 }))
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
    expect(() => VPNClient.validateProfileId('12345678901')).to.throw();
    expect(() => VPNClient.validateProfileId('$(touch /tmp/pwn)')).to.throw();
    expect(() => VPNClient.validateProfileId(123)).to.throw();
  });

  it('skips invalid stored profile IDs without rejecting initialization', async () => {
    const { VPNClient } = installVPNClientStubs();
    class TestVPNClient extends VPNClient {
      static async listProfileIds() { return ['valid_123', 'legacy-profile']; }
      static getKeyNameForInit() { return 'testVpnProfiles'; }
      async getAttributes() { return { profileId: this.profileId }; }
    }
    const originalGetClass = VPNClient.getClass;
    VPNClient.getClass = (type) => type === 'openvpn' ? TestVPNClient : null;
    try {
      expect(await VPNClient.getVPNProfilesForInit()).to.eql({ testVpnProfiles: [{ profileId: 'valid_123' }] });
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

  it('detects an active legacy profile from the cached state', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = 'true';
    expect(await VPNClient.isProfileActive('legacy-profile')).to.equal(true);
    expect(state.execFileCalls).to.have.lengthOf(0);
  });

  it('requires a definitive inactive state before legacy cleanup', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    state.cachedState = null;
    state.execFileResponder = () => Promise.reject(Object.assign(new Error('probe failed'), { code: 127 }));
    expect(await VPNClient.isProfileActive('legacy-profile')).to.equal(null);
  });

  it('validates DNS labels as well as the full hostname', () => {
    const { VPNClient } = installVPNClientStubs();
    expect(VPNClient.isValidFirewallaDDNSDomain('firewalla.com')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain('box.firewalla.com')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain(`${'a'.repeat(64)}.firewalla.com`)).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('evilfirewalla.com')).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('$(touch /tmp/pwn).firewalla.com')).to.equal(false);
  });

  it('uses execFile with discrete arguments for DDNS lookups and ignores later sections', async () => {
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

  it('rejects shell syntax before invoking dig', async () => {
    const { VPNClient, state } = installVPNClientStubs();
    const client = Object.create(VPNClient.prototype);
    expect(await client.resolveFirewallaDDNS('$(touch /tmp/pwn).firewalla.com')).to.equal(undefined);
    expect(state.execCalls).to.have.lengthOf(0);
    expect(state.execFileCalls).to.have.lengthOf(0);
  });
});
