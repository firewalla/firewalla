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

describe('IPv6DiscoverySensor', () => {

  const noop = () => {}
  const br0 = { name: 'br0', ip6_addresses: ['2001:db8::1', 'fe80::1'], mac_address: '00:00:5e:00:53:01', uuid: 'br0-uuid' }
  const br1 = { name: 'br1', ip6_addresses: ['2001:db8:1::1', 'fe80::2'], mac_address: '00:00:5e:00:53:02', uuid: 'br1-uuid' }

  // commands run are recorded, each ip -6 call gets the next table (an Error fails it), emitted events are kept
  function loadSensor(tables = []) {
    const commands = []
    const events = []
    const run = (cmd) => {
      commands.push(cmd)
      const stdout = cmd.startsWith('ip -6') ? tables.shift() || '' : ''
      return stdout instanceof Error ? Promise.reject(stdout) : Promise.resolve({ stdout, stderr: '' })
    }
    const IPv6DiscoverySensor = proxyquire('../sensor/IPv6DiscoverySensor.js', {
      '../util/asyncNative.js': { eachLimit: async (items, limit, fn) => { for (const item of items) await fn(item) } },
      '../net2/logger.js': () => ({ debug: noop, verbose: noop, info: noop, warn: noop, error: noop }),
      '../sensor/SensorEventManager.js': { getInstance: () => ({ emitEvent: (event) => events.push(event) }) },
      './Sensor.js': { Sensor: class { constructor(config) { this.config = config } } },
      '../net2/SysManager.js': { getMonitoringInterfaces: () => [br0, br1] },
      '../net2/MessageBus.js': class { publishCompressed() {} },
      'child-process-promise': {
        exec: (cmd) => run(cmd),
        execFile: (file, args) => run([file].concat(args).join(' ')),
      },
    })
    return { IPv6DiscoverySensor, sensor: new IPv6DiscoverySensor({}), commands, events }
  }

  // the event the sensor emits for one MAC on one interface
  const deviceUpdate = (ipv6Addr, mac, intf) => ({
    type: 'DeviceUpdate',
    message: `A new ipv6 is found @ IPv6DisocverySensor ${ipv6Addr} ${mac}`,
    host: { ipv6Addr, mac, intf_mac: intf.mac_address, intf_uuid: intf.uuid, from: 'ip6neighbor' },
    suppressEventLogging: true,
  })

  describe('parseNeighbor', () => {
    let IPv6DiscoverySensor
    before(() => { ({ IPv6DiscoverySensor } = loadSensor()) })

    it('should read the address, interface, MAC, state and ages of an entry', () => {
      const expected = { ip6: '2001:db8::10', intf: 'br0', mac: '00:00:5E:00:53:10', state: 'STALE', confirmed: 600, updated: 5 }
      // newer iproute2 prints no space before "probes"
      expect(IPv6DiscoverySensor.parseNeighbor('2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10 router  used 120/600/5probes 1 STALE'))
        .to.deep.equal(expected)
      expect(IPv6DiscoverySensor.parseNeighbor('2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10 router used 120/600/5 probes 1 STALE'))
        .to.deep.equal(expected)
    })

    it('should read a line as a Firewalla Gold Pro prints it (iproute2 5.15, with "ref")', () => {
      expect(IPv6DiscoverySensor.parseNeighbor('2001:db8::1 dev br0 lladdr 00:00:5e:00:53:01 router ref 1 used 315/315/315 probes 1 REACHABLE'))
        .to.deep.equal({ ip6: '2001:db8::1', intf: 'br0', mac: '00:00:5E:00:53:01', state: 'REACHABLE', confirmed: 315, updated: 315 })
    })

    it('should find the state when "proto" follows it', () => {
      expect(IPv6DiscoverySensor.parseNeighbor('2001:db8::14 dev br0 lladdr 00:00:5e:00:53:14  used 50/50/50probes 0 PERMANENT proto static').state)
        .to.equal('PERMANENT')
    })

    it('should read an entry printed without ages', () => {
      expect(IPv6DiscoverySensor.parseNeighbor('fe80::10 dev br0 lladdr 00:00:5e:00:53:10 REACHABLE'))
        .to.deep.equal({ ip6: 'fe80::10', intf: 'br0', mac: '00:00:5E:00:53:10', state: 'REACHABLE', confirmed: undefined, updated: undefined })
    })

    it('should skip lines without a usable link-layer address', () => {
      expect(IPv6DiscoverySensor.parseNeighbor('2001:db8::11 dev br0  used 0/0/0probes 6 FAILED')).to.equal(null)
      expect(IPv6DiscoverySensor.parseNeighbor('2001:db8::12 dev br0  used 3/3/3probes 1 INCOMPLETE')).to.equal(null)
      expect(IPv6DiscoverySensor.parseNeighbor('')).to.equal(null)
    })
  })

  describe('isRecent', () => {
    let IPv6DiscoverySensor
    before(() => { ({ IPv6DiscoverySensor } = loadSensor()) })
    const entry = (state, confirmed, updated) => ({ ip6: '2001:db8::10', intf: 'br0', mac: '00:00:5E:00:53:10', state, confirmed, updated })
    const seenBefore = () => new Set(['br0|2001:db8::10|00:00:5E:00:53:10'])

    it('should take an entry the neighbor confirmed since the previous scan', () => {
      expect(IPv6DiscoverySensor.isRecent(entry('REACHABLE', 10, 10), seenBefore(), 900)).to.equal(true)
    })

    it('should take an entry created since the previous scan, though never confirmed', () => {
      // learned from its own NS, never confirmed
      expect(IPv6DiscoverySensor.isRecent(entry('DELAY', 1204, 4), new Set(), 900)).to.equal(true)
      // the first scan
      expect(IPv6DiscoverySensor.isRecent(entry('DELAY', 1204, 4), null, 900)).to.equal(true)
    })

    it('should leave out an entry the kernel only aged since the previous scan', () => {
      // aged from REACHABLE to STALE by the kernel
      expect(IPv6DiscoverySensor.isRecent(entry('STALE', 1500, 200), seenBefore(), 900)).to.equal(false)
    })

    it('should leave out an entry last confirmed just before the previous scan', () => {
      expect(IPv6DiscoverySensor.isRecent(entry('STALE', 930, 330), seenBefore(), 900)).to.equal(false)
    })

    it('should leave out an entry neither confirmed nor updated since the previous scan', () => {
      expect(IPv6DiscoverySensor.isRecent(entry('STALE', 3600, 3000), null, 900)).to.equal(false)
    })

    it('should keep permanent entries, and judge entries without ages by their state', () => {
      expect(IPv6DiscoverySensor.isRecent(entry('PERMANENT', 99999, 99999), seenBefore(), 900)).to.equal(true)
      expect(IPv6DiscoverySensor.isRecent(entry('REACHABLE', undefined, undefined), null, 900)).to.equal(true)
      expect(IPv6DiscoverySensor.isRecent(entry('STALE', undefined, undefined), null, 900)).to.equal(false)
    })
  })

  describe('neighborDiscoveryV6', () => {

    it('should report the neighbors seen since the previous scan, per interface and MAC, and leave the table alone', async () => {
      const { sensor, commands, events } = loadSensor([[
        // learned from its own NS 4 s ago
        '2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10  used 4/1204/4probes 0 DELAY',
        'fe80::10 dev br0 lladdr 00:00:5e:00:53:10 router  used 2/2/2probes 1 REACHABLE',
        // not heard from for an hour
        '2001:db8::20 dev br0 lladdr 00:00:5e:00:53:20  used 3600/3600/3000probes 0 STALE',
        '2001:db8::30 dev br0  used 1/1/1probes 6 FAILED',
        '2001:db8:1::40 dev br1 lladdr 00:00:5e:00:53:40  used 5/5/5probes 1 REACHABLE',
        // not a monitored interface
        '2001:db8:2::50 dev br9 lladdr 00:00:5e:00:53:50  used 5/5/5probes 1 REACHABLE',
        '',
      ].join('\n')])

      await sensor.neighborDiscoveryV6()

      expect(commands).to.include('ip -6 -s neighbor show')
      expect(commands.filter(cmd => cmd.includes('flush'))).to.be.empty
      expect(events).to.deep.equal([
        deviceUpdate(['2001:db8::10', 'fe80::10'], '00:00:5E:00:53:10', br0),
        deviceUpdate(['2001:db8:1::40'], '00:00:5E:00:53:40', br1),
      ])
    })

    it('should not report an entry again when nothing was heard from it since the previous scan', async () => {
      const { sensor, events } = loadSensor([
        '2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10  used 2/2/2probes 1 REACHABLE\n' +
        '2001:db8::12 dev br0 lladdr 00:00:5e:00:53:12  used 30/30/30probes 1 REACHABLE\n',
        // 900 s later: ::10 aged to STALE, ::12 last confirmed 30 s before the previous scan, ::11 new
        '2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10  used 902/902/200probes 1 STALE\n' +
        '2001:db8::12 dev br0 lladdr 00:00:5e:00:53:12  used 930/930/330probes 1 STALE\n' +
        '2001:db8::11 dev br0 lladdr 00:00:5e:00:53:11  used 4/1204/4probes 0 DELAY\n',
      ])
      let clock = 0
      sensor.now = () => clock

      await sensor.neighborDiscoveryV6()
      clock += 900 * 1000
      await sensor.neighborDiscoveryV6()

      expect(events).to.deep.equal([
        deviceUpdate(['2001:db8::10'], '00:00:5E:00:53:10', br0),
        deviceUpdate(['2001:db8::12'], '00:00:5E:00:53:12', br0),
        deviceUpdate(['2001:db8::11'], '00:00:5E:00:53:11', br0),
      ])
    })

    it('should look back to the last successful read after a failed one', async () => {
      const { sensor, events } = loadSensor([
        '2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10  used 2/2/2probes 1 REACHABLE\n',
        new Error('ip failed'),
        // 1800 s after the first read: confirmed between the two reads
        '2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10  used 1500/1500/1100probes 1 STALE\n',
      ])
      let clock = 0
      sensor.now = () => clock

      await sensor.neighborDiscoveryV6()
      clock += 900 * 1000
      let failed = false
      await sensor.neighborDiscoveryV6().catch(() => { failed = true })
      clock += 900 * 1000
      await sensor.neighborDiscoveryV6()

      expect(failed).to.equal(true)
      expect(events).to.deep.equal([
        deviceUpdate(['2001:db8::10'], '00:00:5E:00:53:10', br0),
        deviceUpdate(['2001:db8::10'], '00:00:5E:00:53:10', br0),
      ])
    })
  })
})
