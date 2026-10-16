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

// the Host:Updated handler must keep the ipv4 entries of hostsdb in sync

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();

// a value that can be called, constructed and dereferenced to any depth,
// stands in for the singletons and clients HostManager builds at load time
function anything() {
  const proxy = new Proxy(function () {}, {
    get: (target, prop) => (prop === 'then' || typeof prop === 'symbol') ? undefined : proxy,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function loadHostManager(subscriptions) {
  const src = fs.readFileSync(path.join(__dirname, '../net2/HostManager.js'), 'utf8');
  const stubs = {};
  for (const [, name] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    stubs[name] = anything();
  }
  stubs['./Constants.js'] = require('../net2/Constants.js');
  stubs['lodash'] = require('lodash');
  stubs['./Monitorable.js'] = class {};
  stubs['./MessageBus.js'] = class {
    subscribe(channel, type, id, handler) { subscriptions[channel] = handler; }
  };
  return proxyquire('../net2/HostManager.js', stubs);
}

describe('HostManager Host:Updated ipv4 cache', function () {
  let hostManager, onHostUpdated;

  beforeEach(() => {
    const subscriptions = {};
    const HostManager = loadHostManager(subscriptions);
    hostManager = new HostManager();
    onHostUpdated = subscriptions['Host:Updated'];
  });

  // a Host keeps its address in host.o only, Host.onUpdate has already applied the new one
  function hostWithIPv4(mac, ipv4Addr) {
    const host = { o: { mac, ipv4Addr } };
    hostManager.getHostFastByMAC = (m) => m === mac ? host : undefined;
    return host;
  }

  it('maps the new ipv4 to the host and drops the address it left', async () => {
    const host = hostWithIPv4('AA:BB:CC:DD:EE:01', '192.168.1.20');
    hostManager.hostsdb['host:ip4:192.168.1.10'] = host;

    await onHostUpdated('Host:Updated', host.o.mac, null, { mac: host.o.mac, ipv4Addr: '192.168.1.20' });

    expect(hostManager.hostsdb['host:ip4:192.168.1.20']).to.equal(host);
    expect(hostManager.hostsdb).to.not.have.property('host:ip4:192.168.1.10');
  });

  it('takes over an ipv4 that was cached for another device', async () => {
    const other = { o: { mac: 'AA:BB:CC:DD:EE:02', ipv4Addr: '192.168.1.30' } };
    const host = hostWithIPv4('AA:BB:CC:DD:EE:01', '192.168.1.30');
    hostManager.hostsdb['host:ip4:192.168.1.30'] = other;
    hostManager.hostsdb['host:ip4:192.168.1.10'] = host;

    await onHostUpdated('Host:Updated', host.o.mac, null, { mac: host.o.mac, ipv4Addr: '192.168.1.30' });

    expect(hostManager.hostsdb['host:ip4:192.168.1.30']).to.equal(host);
    expect(hostManager.hostsdb).to.not.have.property('host:ip4:192.168.1.10');
  });

  it('leaves the ipv4 entries of other devices alone', async () => {
    const other = { o: { mac: 'AA:BB:CC:DD:EE:02', ipv4Addr: '192.168.1.40' } };
    const host = hostWithIPv4('AA:BB:CC:DD:EE:01', '192.168.1.20');
    hostManager.hostsdb['host:ip4:192.168.1.40'] = other;

    await onHostUpdated('Host:Updated', host.o.mac, null, { mac: host.o.mac, ipv4Addr: '192.168.1.20' });

    expect(hostManager.hostsdb['host:ip4:192.168.1.40']).to.equal(other);
    expect(hostManager.hostsdb['host:ip4:192.168.1.20']).to.equal(host);
  });
});
