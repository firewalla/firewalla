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

const { expect } = require('chai');

const fireRouter = require('../net2/FireRouter.js');
const sysManager = require('../net2/SysManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const DestInfoIntel = require('../intel/DestInfoIntel.js');

// documentation address, outside every subnet of a box
const KNOWN = '2001:db8:6151::10';

describe('DestInfoIntel local destination', function () {
  this.timeout(30000);

  before(async function () {
    await fireRouter.waitTillReady();
    await sysManager.updateAsync();

    const hosts = await hostManager.getHostsAsync();
    const host = hosts.find(h => h.o.mac && !sysManager.isMyMac(h.o.mac));
    if (!host) this.skip();
    this.mac = host.o.mac;
    // a device seen on the LAN at an address from a prefix the box no longer has
    await rclient.hmsetAsync(`host:ip6:${KNOWN}`, { mac: this.mac });
    await rclient.expireAsync(`host:ip6:${KNOWN}`, 120);
  });

  after(async function () {
    await rclient.unlinkAsync(`host:ip6:${KNOWN}`);
  });

  it('marks a known device outside the box subnets as a local destination', async function () {
    expect(sysManager.isLocalIP(KNOWN)).to.equal(false);
    const alarm = await new DestInfoIntel().enrichAlarm({ type: 'ALARM_BRO_NOTICE', 'p.dest.ip': KNOWN });

    expect(alarm['p.dest.isLocal']).to.equal('1');
    expect(alarm['p.dest.mac']).to.equal(this.mac);
  });
});
