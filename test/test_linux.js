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

  it('returns null for a directly connected default route without a gateway', () => {
    execFileSync = () => (
      'default dev eth0 proto kernel metric 256\n'
    );

    expect(linux.gateway_ip6_sync('eth0')).to.equal(null);
  });
});

describe('NetworkTool.listInterfaces', function () {
  let createNetworkTool;
  let gatewayCalls;

  beforeEach(() => {
    gatewayCalls = [];

    createNetworkTool = proxyquire('../net2/NetworkTool.js', {
      '../util/linux.js': {
        get_network_interfaces_list: async () => [
          {
            name: 'eth0',
            ip_address: '192.0.2.10',
            mac_address: '00:11:22:33:44:55',
            conn_type: 'Wired',
            gateway_ip: '192.0.2.1',
          },
          {
            name: 'eth1',
            ip_address: '198.51.100.10',
            mac_address: '00:11:22:33:44:66',
            conn_type: 'Wired',
            gateway_ip: '198.51.100.1',
          },
        ],

        gateway_ip6_sync: (interfaceName) => {
          gatewayCalls.push(interfaceName);

          const gateways = {
            eth0: 'fe80::1',
            eth1: 'fe80::2',
          };

          return gateways[interfaceName] || null;
        },
      },

      './logger.js': () => ({
        info: () => {},
        error: () => {},
      }),

      './config.js': {
        getConfig: () => ({}),
      },

      '../platform/PlatformLoader.js': {
        getPlatform: () => ({
          getSubnetCapacity: () => 64,
        }),
      },

      'dns': {
        getServers: () => [
          '192.0.2.1',
        ],
      },

      'os': {
        networkInterfaces: () => ({
          eth0: [
            {
              family: 'IPv4',
              address: '192.0.2.10',
              internal: false,
              cidr: '192.0.2.0/24',
            },
          ],
          eth1: [
            {
              family: 'IPv4',
              address: '198.51.100.10',
              internal: false,
              cidr: '198.51.100.0/24',
            },
          ],
        }),
      },
    });
  });

  it('passes each interface name to gateway_ip6_sync and assigns the result to that interface', async function () {
    const networkTool = createNetworkTool();
    const result = await networkTool.listInterfaces();

    expect(gatewayCalls).to.deep.equal([
      'eth0',
      'eth1',
    ]);

    expect(result).to.have.lengthOf(2);

    expect(result[0].name).to.equal('eth0');
    expect(result[0].gateway6).to.equal('fe80::1');

    expect(result[1].name).to.equal('eth1');
    expect(result[1].gateway6).to.equal('fe80::2');
  });
});
