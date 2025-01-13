/*    Copyright 2016-2024 Firewalla Inc.
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
'use strict'

let _ = require('lodash');
let chai = require('chai');
let expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');

let fireRouter = require('../net2/FireRouter.js')
let sysManager = require('../net2/SysManager');
const Host = require('../net2/Host.js');
const HostManager = require('../net2/HostManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const hostManager = new HostManager();
const DnsLoopAvoidanceSensor = require('../sensor/DnsLoopAvoidanceSensor.js');
const dnsLoopSensor = new DnsLoopAvoidanceSensor();

describe('Test dns loop sensor', function(){
  this.timeout(30000);

  before(async() => {
      const hostkeys = await rclient.keysAsync("host:mac:*");
      for (let key of hostkeys) {
          const hostinfo = await rclient.hgetallAsync(key);
          const host = new Host(hostinfo, true);
          hostManager.hostsdb[`host:mac:${host.o.mac}`] = host
          hostManager.hosts.all.push(host);
      }
      hostManager.hosts.all = _.uniqWith(hostManager.hosts.all, (a,b) => a.o.ipv4 == b.o.ipv4 && a.o.mac == b.o.mac)
      await fireRouter.init();
      await sysManager.updateAsync();
  });

  after(async() => {
  });

  it('should check dns loop', async()=> {
    await dnsLoopSensor.check();
  });
});
