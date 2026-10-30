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
const EventEmitter = require('events');
const Message = require('../net2/Message.js');

describe('Test Layer2.getMAC6Async', () => {

  // a fresh module per test, so the module-level caches start empty, and a private event
  // manager, so no listener outlives the test
  function loadLayer2(neighOutputs, { ipFails = false, ipHangs = false } = {}) {
    const calls = []
    const execFile = (file, args) => {
      calls.push([file].concat(args))
      if (file === 'ip') {
        if (ipHangs) return new Promise(() => {})
        if (ipFails) return Promise.reject(new Error('Cannot find device'))
        return Promise.resolve({ stdout: neighOutputs.shift() || '', stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const sem = new EventEmitter()
    const l2 = proxyquire('../util/Layer2.js', {
      'child-process-promise': { execFile },
      '../sensor/SensorEventManager.js': { getInstance: () => sem, '@noCallThru': true },
    })
    return { l2, calls, sem }
  }

  it('should use a usable cache entry without probing', async () => {
    const { l2, calls } = loadLayer2(['2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10 STALE\n'])
    expect(await l2.getMAC6Async('2001:db8::10')).to.equal('00:00:5E:00:53:10')
    expect(calls).to.deep.equal([['ip', '-6', 'neigh', 'show', '2001:db8::10']])
  })

  it('should ping on the given interface when the entry is not usable, then read again', async () => {
    const { l2, calls } = loadLayer2([
      'fe80::1 FAILED\n',
      'fe80::1 lladdr 00:00:5e:00:53:01 router REACHABLE\n',
    ])
    expect(await l2.getMAC6Async('fe80::1', 'eth0')).to.equal('00:00:5E:00:53:01')
    expect(calls).to.deep.equal([
      ['ip', '-6', 'neigh', 'show', 'fe80::1', 'dev', 'eth0'],
      ['ping6', '-c', '1', '-W', '1', '-I', 'eth0', 'fe80::1'],
      ['ip', '-6', 'neigh', 'show', 'fe80::1', 'dev', 'eth0'],
    ])
  })

  it('should return null and skip the next lookup when nothing answers', async () => {
    const { l2, calls } = loadLayer2(['fe80::1 INCOMPLETE\n', ''])
    expect(await l2.getMAC6Async('fe80::1', 'eth0')).to.be.null
    expect(await l2.getMAC6Async('fe80::1', 'eth0')).to.be.null
    expect(calls.length).to.equal(3)
  })

  it('should cache a link-local address per interface', async () => {
    const { l2 } = loadLayer2([
      'fe80::1 lladdr 00:00:5e:00:53:01 router STALE\n',
      'fe80::1 lladdr 00:00:5e:00:53:02 router STALE\n',
    ])
    expect(await l2.getMAC6Async('fe80::1', 'eth0')).to.equal('00:00:5E:00:53:01')
    expect(await l2.getMAC6Async('fe80::1', 'eth1')).to.equal('00:00:5E:00:53:02')
  })

  it('should return null rather than throw when ip fails', async () => {
    const { l2 } = loadLayer2([], { ipFails: true })
    expect(await l2.getMAC6Async('fe80::1', 'eth9')).to.be.null
  })

  it('should drop the interface-keyed entry when the mapping is deleted', async () => {
    const { l2, calls, sem } = loadLayer2([
      'fe80::1 lladdr 00:00:5e:00:53:01 router STALE\n',
      'fe80::1 lladdr 00:00:5e:00:53:02 router STALE\n',
    ])
    expect(await l2.getMAC6Async('fe80::1', 'eth0')).to.equal('00:00:5E:00:53:01')
    sem.emit(Message.MSG_MAPPING_IP_MAC_DELETED, { ip: 'fe80::1', mac: '00:00:5E:00:53:01', fam: 6 })
    expect(await l2.getMAC6Async('fe80::1', 'eth0')).to.equal('00:00:5E:00:53:02')
    expect(calls.length).to.equal(2)
  })

  it('should run one probe for concurrent lookups of the same address', async () => {
    const { l2, calls } = loadLayer2(['2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10 STALE\n'])
    const results = await Promise.all([l2.getMAC6Async('2001:db8::10'), l2.getMAC6Async('2001:db8::10')])
    expect(results).to.deep.equal(['00:00:5E:00:53:10', '00:00:5E:00:53:10'])
    expect(calls.length).to.equal(1)
  })

  it('should not queue probes past the backlog bound', async () => {
    const { l2, calls } = loadLayer2([], { ipHangs: true })
    // 4 probes run and hang, the next 100 wait in the queue
    for (let i = 0; i < 104; i++)
      l2.getMAC6Async(`2001:db8::${(i + 1).toString(16)}`)
    expect(await l2.getMAC6Async('2001:db8::ffff')).to.be.null
    expect(calls.length).to.equal(4)
  })
});
