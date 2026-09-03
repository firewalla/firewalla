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

describe('VPNClient shell and path hardening', function () {
  let execCalls;
  let execFileCalls;
  let execFileResponder;
  let VPNClient;

  beforeEach(() => {
    execCalls = [];
    execFileCalls = [];
    execFileResponder = () => Promise.resolve({stdout: ''});

    VPNClient = proxyquire('../extension/vpnclient/VPNClient.js', {
      '../../net2/Firewalla.js': {
        isMain: () => false
      },
      '../../util/redis_manager.js': {
        getSubscriptionClient: () => ({on: () => {}}),
        rclient: {
          unlinkAsync: () => Promise.resolve(),
          delAsync: () => Promise.resolve()
        }
      },
      'child-process-promise': {
        exec: (...args) => {
          execCalls.push(args);
          return Promise.reject(new Error('shell execution was not expected'));
        },
        execFile: (...args) => {
          execFileCalls.push(args);
          return execFileResponder(...args);
        }
      }
    });
  });

  it('enforces the profileId format at the VPNClient boundary', () => {
    expect(() => VPNClient.validateProfileId('valid_123')).to.not.throw();
    expect(() => VPNClient.validateProfileId('../escape')).to.throw();
    expect(() => VPNClient.validateProfileId('bad-name')).to.throw();
    expect(() => VPNClient.validateProfileId('12345678901')).to.throw();
    expect(() => VPNClient.validateProfileId('$(touch /tmp/pwn)')).to.throw();
    expect(() => VPNClient.validateProfileId(123)).to.throw();
  });

  it('enforces profileId validation through a concrete client constructor', () => {
    class TestVPNClient extends VPNClient {
      static getProtocol() {
        return 'test';
      }
    }

    expect(() => new TestVPNClient({ profileId: 'valid_123' })).to.not.throw();
    expect(() => new TestVPNClient({ profileId: 'bad-name' })).to.throw(/profileId/);
    expect(() => new TestVPNClient({ profileId: '../escape' })).to.throw(/profileId/);
  });

  it('deletes the protocol-specific primary stored profile artifact', async () => {
    const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vpnclient-'));
    const profileId = 'legacy_profile';
    const suffixes = ['.settings', '.json', '.endpoint_routes', '.ovpn'];

    class TestVPNClient extends VPNClient {
      static getConfigDirectory() {
        return configDirectory;
      }

      static getPrimaryProfilePath(profileId) {
        return path.join(configDirectory, `${profileId}.ovpn`);
      }
    }

    try {
      await Promise.all(suffixes.map((suffix) => fs.writeFile(path.join(configDirectory, `${profileId}${suffix}`), 'test')));
      await TestVPNClient.destroyStoredProfile(profileId);

      for (const suffix of suffixes)
        expect(await fs.access(path.join(configDirectory, `${profileId}${suffix}`)).then(() => true).catch(() => false)).to.equal(false);
    } finally {
      await fs.rm(configDirectory, { recursive: true, force: true });
    }
  });

  it('skips invalid stored profile IDs without rejecting initialization', async () => {
    class TestVPNClient extends VPNClient {
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
      const result = await VPNClient.getVPNProfilesForInit();
      expect(result).to.eql({
        testVpnProfiles: [{ profileId: 'valid_123' }]
      });
    } finally {
      VPNClient.getClass = originalGetClass;
    }
  });

  it('identifies the OpenVPN .ovpn file as the primary stored profile', () => {
    const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
    const primaryPath = OpenVPNClient.getPrimaryProfilePath('valid_123');
    expect(primaryPath).to.match(/[/\\]valid_123\.ovpn$/);
  });

  it('accepts only actual firewalla.com and firewalla.org hostnames', () => {
    expect(VPNClient.isValidFirewallaDDNSDomain('firewalla.com')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain('box.firewalla.com')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain('box.example.firewalla.org')).to.equal(true);
    expect(VPNClient.isValidFirewallaDDNSDomain('evilfirewalla.com')).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('example.com.firewalla.com.evil')).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('$(touch /tmp/pwn).firewalla.com')).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('-bad.firewalla.com')).to.equal(false);
    expect(VPNClient.isValidFirewallaDDNSDomain('bad-.firewalla.com')).to.equal(false);
  });

  it('uses execFile with discrete arguments for DDNS lookups', async () => {
    execFileResponder = (binary, args) => {
      if (args[0] === '+time=3' && args.includes('SOA')) {
        return Promise.resolve({
          stdout: ';; AUTHORITY SECTION:\nfirewalla.com. 300 IN SOA ns1.firewalla.com. hostmaster.firewalla.com. 1 2 3 4 5\n'
        });
      }
      if (args.includes('NS')) {
        return Promise.resolve({
          stdout: 'ns1.firewalla.com.\nns2.firewalla.com.\n'
        });
      }
      return Promise.resolve({stdout: '192.0.2.53\n'});
    };

    const client = Object.create(VPNClient.prototype);
    const result = await client.resolveFirewallaDDNS('box.firewalla.com');

    expect(result).to.equal('192.0.2.53');
    expect(execCalls).to.have.lengthOf(0);
    expect(execFileCalls).to.have.lengthOf(3);
    expect(execFileCalls[0][0]).to.equal('dig');
    expect(execFileCalls[0][1]).to.eql(['+time=3', '+tries=2', 'SOA', 'box.firewalla.com']);
    expect(execFileCalls[1][1]).to.eql(['+time=3', '+tries=2', '+short', 'NS', 'firewalla.com.']);
    expect(execFileCalls[2][1]).to.eql(['+short', '+time=3', '+tries=1', '@ns1.firewalla.com.', 'A', 'box.firewalla.com']);
  });

  it('rejects shell syntax before invoking dig', async () => {
    const client = Object.create(VPNClient.prototype);
    const result = await client.resolveFirewallaDDNS('$(touch /tmp/pwn).firewalla.com');

    expect(result).to.equal(undefined);
    expect(execCalls).to.have.lengthOf(0);
    expect(execFileCalls).to.have.lengthOf(0);
  });
});
