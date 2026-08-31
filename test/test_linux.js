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
const proxyquire = require('proxyquire').noCallThru();

describe('gateway_ip6_sync', function () {
  let execFileSync;
  let linux;

  beforeEach(() => {
    execFileSync = function () {
      return '';
    };

    linux = proxyquire('../util/linux.js', {
      'child_process': {
        exec: require('child_process').exec,
        execFileSync: (...args) => execFileSync(...args),
      },
    });
  });

  it('returns the gateway for each requested interface when multiple default routes exist', () => {
    execFileSync = () => (
      'default via fe80::1 dev eth0 proto ra metric 100\n' +
      'default via fe80::2 dev eth1 proto ra metric 200\n'
    );

    expect(linux.gateway_ip6_sync('eth0')).to.equal('fe80::1');
    expect(linux.gateway_ip6_sync('eth1')).to.equal('fe80::2');
  });

  it('returns null when there is no matching default route', () => {
    execFileSync = () => '2001:db8:1::/64 dev eth0 proto kernel\n';

    expect(linux.gateway_ip6_sync('eth0')).to.equal(null);
  });

  it('returns the gateway from the matching later multipath nexthop', () => {
    execFileSync = () => (
      'default proto static\n' +
      'nexthop via fe80::1 dev eth0 weight 1\n' +
      'nexthop via fe80::2 dev eth1 weight 1\n'
    );

    expect(linux.gateway_ip6_sync('eth1')).to.equal('fe80::2');
  });

  it('returns the gateway from a source-specific default route', () => {
    execFileSync = () => (
      'default from 2001:db8:100::/64 via fe80::2 dev eth1 proto ra metric 100\n'
    );

    expect(linux.gateway_ip6_sync('eth1')).to.equal('fe80::2');
  });

  it('normalizes a legacy alias before route lookup', () => {
    let capturedArgs;

    execFileSync = (...args) => {
      capturedArgs = args;
      return 'default via fe80::1 dev eth0 proto ra metric 100\n';
    };

    expect(linux.gateway_ip6_sync('eth0:0')).to.equal('fe80::1');
    expect(capturedArgs).to.deep.equal([
      '/sbin/ip',
      ['-6', 'route', 'show', 'default', 'dev', 'eth0'],
      { encoding: 'utf8' },
    ]);
  });

  it('returns null when the route command fails', () => {
    execFileSync = () => {
      throw new Error('ip failed');
    };

    expect(linux.gateway_ip6_sync('eth0')).to.equal(null);
  });

  it('preserves the no-argument behavior', () => {
    let capturedArgs;

    execFileSync = (...args) => {
      capturedArgs = args;
      return (
        '2001:db8:1::/64 dev eth0 proto kernel\n' +
        'default via fe80::9 dev eth1 proto ra metric 100\n' +
        'default via fe80::8 dev eth0 proto ra metric 200\n'
      );
    };

    expect(linux.gateway_ip6_sync()).to.equal('fe80::9');
    expect(capturedArgs).to.deep.equal([
      '/sbin/ip',
      ['-6', 'route'],
      { encoding: 'utf8' },
    ]);
  });
});
