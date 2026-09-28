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
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();

describe('DNSUpstreamHealthCheck', () => {
  function loadHelper(execFileImpl, config = { dns: { verificationDomains: ['health.firewalla.test'] } }) {
    return proxyquire('../util/DNSUpstreamHealthCheck.js', {
      '../net2/logger.js': () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      }),
      'child-process-promise': {
        execFile: execFileImpl
      },
      '../net2/config.js': {
        getConfig: () => config
      }
    });
  }

  it('should normalize IPv4, hostname and bracketed IPv6 server specs', () => {
    const helper = loadHelper(async () => ({ stdout: '' }));

    expect(helper.normalizeServerSpec('1.1.1.1')).to.deep.equal({
      raw: '1.1.1.1',
      host: '1.1.1.1',
      port: null
    });
    expect(helper.normalizeServerSpec('resolver.example.com#5353')).to.deep.equal({
      raw: 'resolver.example.com#5353',
      host: 'resolver.example.com',
      port: 5353
    });
    expect(helper.normalizeServerSpec('[2606:4700:4700::1111]#5353')).to.deep.equal({
      raw: '[2606:4700:4700::1111]#5353',
      host: '2606:4700:4700::1111',
      port: 5353
    });
  });

  it('should parse only valid IP addresses from dig output', () => {
    const helper = loadHelper(async () => ({ stdout: '' }));
    expect(helper.parseAddresses('1.1.1.1\nnot-an-ip\n2606:4700:4700::1111\n')).to.deep.equal([
      '1.1.1.1',
      '2606:4700:4700::1111'
    ]);
  });

  it('should build dig args with port and query type', () => {
    const helper = loadHelper(async () => ({ stdout: '' }));
    const args = helper.buildDigArgs({
      host: '127.0.0.1',
      port: 8854,
      domain: 'example.com',
      timeout: 4,
      tries: 3
    });
    expect(args).to.deep.equal(['-p', '8854', '@127.0.0.1', 'example.com', 'A', '+short', '+time=4', '+tries=3']);
  });

  it('should build dig args for an IPv6 host without brackets (dig does not accept @[ipv6])', () => {
    const helper = loadHelper(async () => ({ stdout: '' }));
    const args = helper.buildDigArgs({
      host: '2606:4700:4700::1111',
      port: null,
      domain: 'example.com'
    });
    expect(args).to.deep.equal(['@2606:4700:4700::1111', 'example.com', 'A', '+short', '+time=3', '+tries=2']);
  });

  it('should probe a server successfully when dig returns addresses', async () => {
    let seenArgs = null;
    const helper = loadHelper(async (cmd, args) => {
      seenArgs = args;
      return { stdout: '104.18.0.1\n104.18.0.2\n', stderr: '' };
    });

    const result = await helper.probeServer('1.1.1.1#53', {
      domains: ['example.com'],
      timeout: 3,
      tries: 2
    });

    expect(seenArgs).to.include("@1.1.1.1");
    expect(result.healthy).to.equal(true);
    expect(result.domain).to.equal('example.com');
    expect(result.addresses).to.deep.equal(['104.18.0.1', '104.18.0.2']);
  });

  it('should report unhealthy when every probe fails', async () => {
    const helper = loadHelper(async () => {
      const err = new Error('dig failed');
      err.stderr = 'connection timed out';
      throw err;
    });

    const result = await helper.probeLocalServer('127.0.0.1', 8953, {
      domains: ['example.com']
    });

    expect(result.healthy).to.equal(false);
    expect(result.error).to.include('connection timed out');
  });

  it('should report empty server as unhealthy without running dig', async () => {
    let execCalled = false;
    const helper = loadHelper(async () => {
      execCalled = true;
      return { stdout: '' };
    });

    const result = await helper.probeServer('', {
      domains: ['example.com']
    });

    expect(execCalled).to.equal(false);
    expect(result.healthy).to.equal(false);
    expect(result.error).to.equal('empty server');
  });

  it('should summarize an empty result set as unhealthy', () => {
    const helper = loadHelper(async () => ({ stdout: '' }));
    const summary = helper.summarizeProbeResults([]);

    expect(summary.healthy).to.equal(false);
    expect(summary.firstHealthy).to.equal(undefined);
    expect(summary.firstError).to.equal(undefined);
    expect(summary.error).to.equal(null);
  });

  it('should summarize multiple probe results', () => {
    const helper = loadHelper(async () => ({ stdout: '' }));
    const summary = helper.summarizeProbeResults([
      { server: '1.1.1.1', healthy: false, error: 'timeout' },
      { server: '9.9.9.9', healthy: true, addresses: ['9.9.9.9'] }
    ]);

    expect(summary.healthy).to.equal(true);
    expect(summary.firstHealthy.server).to.equal('9.9.9.9');
    expect(summary.firstError.server).to.equal('1.1.1.1');
  });
});
