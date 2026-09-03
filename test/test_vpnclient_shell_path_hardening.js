/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 */

'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

describe('VPNClient shell and path hardening', function () {
  let execCalls;
  let execFileCalls;
  let VPNClient;

  beforeEach(() => {
    execCalls = [];
    execFileCalls = [];
    VPNClient = proxyquire('../extension/vpnclient/VPNClient.js', {
      'child-process-promise': {
        exec: (...args) => {
          execCalls.push(args);
          return Promise.reject(new Error('shell execution was not expected'));
        },
        execFile: (...args) => {
          execFileCalls.push(args);
          return Promise.resolve({stdout: ''});
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
    execCalls.length = 0;
    execFileCalls.length = 0;
    execFileCalls.push = Array.prototype.push;

    const originalExecFile = execFileCalls;
    execFileCalls.length = 0;

    const proxiedVPNClient = proxyquire('../extension/vpnclient/VPNClient.js', {
      'child-process-promise': {
        exec: (...args) => {
          execCalls.push(args);
          return Promise.reject(new Error('shell execution was not expected'));
        },
        execFile: (...args) => {
          originalExecFile.push(args);
          const command = args[1] || [];
          if (command[0] === '+time=3' && command.includes('SOA')) {
            return Promise.resolve({
              stdout: ';; AUTHORITY SECTION:\nfirewalla.com. 300 IN SOA ns1.firewalla.com. hostmaster.firewalla.com. 1 2 3 4 5\n'
            });
          }
          if (command.includes('NS')) {
            return Promise.resolve({
              stdout: 'ns1.firewalla.com.\nns2.firewalla.com.\n'
            });
          }
          return Promise.resolve({stdout: '192.0.2.53\n'});
        }
      }
    });

    const client = Object.create(proxiedVPNClient.prototype);
    const result = await client.resolveFirewallaDDNS('box.firewalla.com');

    expect(result).to.equal('192.0.2.53');
    expect(execCalls).to.have.lengthOf(0);
    expect(originalExecFile).to.have.lengthOf(3);
    expect(originalExecFile[0][0]).to.equal('dig');
    expect(originalExecFile[0][1]).to.eql(['+time=3', '+tries=2', 'SOA', 'box.firewalla.com']);
    expect(originalExecFile[1][1]).to.eql(['+time=3', '+tries=2', '+short', 'NS', 'firewalla.com.']);
    expect(originalExecFile[2][1]).to.eql(['+short', '+time=3', '+tries=1', '@ns1.firewalla.com.', 'A', 'box.firewalla.com']);
  });

  it('rejects shell syntax before invoking dig', async () => {
    const execFileCalls = [];
    const VPNClient = proxyquire('../extension/vpnclient/VPNClient.js', {
      'child-process-promise': {
        exec: () => Promise.reject(new Error('shell execution was not expected')),
        execFile: (...args) => {
          execFileCalls.push(args);
          return Promise.resolve({stdout: ''});
        }
      }
    });

    const client = Object.create(VPNClient.prototype);
    const result = await client.resolveFirewallaDDNS('$(touch /tmp/pwn).firewalla.com');

    expect(result).to.equal(undefined);
    expect(execFileCalls).to.have.lengthOf(0);
  });
});
