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
const proxyquire = require('proxyquire');

describe('Test Discovery.discoverMac', function() {
  this.timeout(10000);

  const intfs = [
    { name: 'br0', subnet: '192.0.2.1/24' },
    { name: 'br1', subnet: '198.51.100.1/24' },
  ]

  const ARP_HEADER = 'IP address       HW type     Flags       HW address            Mask     Device\n'

  function loadDiscovery(arpRows, scanResults) {
    const scanned = []
    const nmap = {
      scanAsync: async (subnet) => {
        scanned.push(subnet)
        return scanResults[subnet] || []
      }
    }
    const fs = {
      readFile: (path, cb) => cb(null, Buffer.from(ARP_HEADER + arpRows.join('\n') + '\n'))
    }
    const Discovery = proxyquire('../net2/Discovery.js', {
      './Nmap.js': nmap,
      './SysManager.js': { getMonitoringInterfaces: () => intfs },
      'fs': fs,
    })
    const d = new Discovery('test-discover-mac', {}, 'info', false)
    return { d, scanned }
  }

  it('should return the ARP entry without scanning', async () => {
    const { d, scanned } = loadDiscovery([
      '192.0.2.10       0x1         0x2         00:00:5e:00:53:10     *        br0',
    ], {})
    const found = await d.discoverMac('00:00:5E:00:53:10')
    expect(found.ipv4Addr).to.equal('192.0.2.10')
    expect(scanned).to.be.empty
  })

  it('should scan until the MAC is found when the ARP table does not have it', async () => {
    const host = { ipv4Addr: '198.51.100.20', mac: '00:00:5E:00:53:20' }
    const { d, scanned } = loadDiscovery([], { '198.51.100.1/24': [host] })
    expect(await d.discoverMac('00:00:5E:00:53:20')).to.equal(host)
    expect(scanned).to.deep.equal(['192.0.2.1/24', '198.51.100.1/24'])
  })

  it('should scan for a MAC whose only ARP entry has failed', async () => {
    const host = { ipv4Addr: '198.51.100.30', mac: '00:00:5E:00:53:30' }
    const { d, scanned } = loadDiscovery([
      '192.0.2.30       0x1         0x0         00:00:5e:00:53:30     *        br0',
    ], { '198.51.100.1/24': [host] })
    expect(await d.discoverMac('00:00:5E:00:53:30')).to.equal(host)
    expect(scanned).to.deep.equal(['192.0.2.1/24', '198.51.100.1/24'])
  })

  it('should keep the complete ARP entry when a failed one for the same MAC follows it', async () => {
    const { d, scanned } = loadDiscovery([
      '192.0.2.40       0x1         0x2         00:00:5e:00:53:40     *        br0',
      '192.0.2.41       0x1         0x0         00:00:5e:00:53:40     *        br0',
    ], {})
    const found = await d.discoverMac('00:00:5E:00:53:40')
    expect(found.ipv4Addr).to.equal('192.0.2.40')
    expect(scanned).to.be.empty
  })
});
