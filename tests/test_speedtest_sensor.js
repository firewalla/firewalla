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

let chai = require('chai');
let expect = chai.expect;

const log = require('../net2/logger.js')(__filename);
const InternetSpeedtestPlugin = require('../sensor/InternetSpeedtestPlugin.js');
const sysManager = require('../net2/SysManager.js');
const LRU = require('lru-cache');

function delay(t) {
    return new Promise(function(resolve) {
        setTimeout(resolve, t)
    });
}

const config = {
    "vendorCandidates": [
      "ookla"
    ],
    "switchRatioThreshold": 0.88
};


describe('Test internet speedtest', function(){
    this.timeout(90000);

    before((done) => {
      this.plugin = new InternetSpeedtestPlugin(config);
      this.plugin.running = false;
      this.plugin.manualRunTsCache = new LRU({maxAge: 86400 * 1000, max: 10});
      this.plugin.runningCache = new LRU({max: 3, maxAge: 3600 * 1000});

      sysManager.uuidMap = {};
      sysManager.uuidMap["1f97bb38-7592-4be0-8ea4-b53d353a2d01"] = {"name":"eth0","uuid":"1f97bb38-7592-4be0-8ea4-b53d353a2d01","mac_address":"20:6d:31:01:2b:43","ip_address":"192.168.203.134","subnet":"192.168.203.134/24","netmask":"255.255.255.0","gateway_ip":"192.168.203.1","gateway":"192.168.203.1","ip4_addresses":["192.168.203.134"],"ip4_subnets":["192.168.203.134/24"],"ip4_masks":["255.255.255.0"],"ip6_addresses":null,"ip6_subnets":null,"ip6_masks":null,"gateway6":"","dns":["192.168.203.1","8.8.8.8"],"resolver":null,"resolverFromWan":false,"conn_type":"Wired","type":"wan","rtid":11,"searchDomains":[],"localDomains":[],"rt4_subnets":null,"rt6_subnets":null,"ready":true,"active":true,"pendingTest":false,"origDns":["10.8.8.8"],"pds":null};
      sysManager.uuidMap["5da8a81-4881-4fcd-964f-7cb935355acc"] = {"name":"br0","uuid":"75da8a81-4881-4fcd-964f-7cb935355acc","mac_address":"20:6d:31:01:2b:40","ip_address":"192.168.196.1","subnet":"192.168.196.1/24","netmask":"255.255.255.0","gateway_ip":null,"gateway":null,"ip4_addresses":["192.168.196.1"],"ip4_subnets":["192.168.196.1/24"],"ip4_masks":["255.255.255.0"],"ip6_addresses":null,"ip6_subnets":null,"ip6_masks":null,"gateway6":null,"dns":null,"resolver":["192.168.203.1","8.8.8.8"],"resolverFromWan":true,"conn_type":"Wired","type":"lan","rtid":8,"searchDomains":["lan"],"localDomains":[],"rt4_subnets":null,"rt6_subnets":null,"origDns":null,"pds":null};
      sysManager.nicinfo = sysManager.sysinfo;
      done();
    });

    after((done) => {
      done();
    });

    it('should wait for condition', async()=> {
        let waitFalse = true;
        log.debug('[1]', new Date()/1000, 'waitFalse', waitFalse);
        setTimeout(() => {waitFalse = false}, 1000);
        log.debug('[2]', new Date()/1000, 'waitFalse', waitFalse);
        await InternetSpeedtestPlugin.waitFor( _ => waitFalse != true);
        log.debug('[3]', new Date()/1000, 'waitFalse', waitFalse);
        expect(waitFalse).to.be.false;
    });

    it('should wait for condition but timeout', async() => {
        let waitFalse = true;
        log.debug('[4]', new Date()/1000, 'waitFalse', waitFalse);
        await InternetSpeedtestPlugin.waitFor( _ => waitFalse != true, 1000).catch((err) => {
          log.debug('expected timeout exception,', err);
        });
        log.debug('[5]', new Date()/1000, 'waitFalse', waitFalse);
        expect(waitFalse).to.be.true;
    });

    it('should get job result', async() => {
      this.plugin.runningCache.set(1713241367.088, {state: 0});
      expect(this.plugin.getJobState(1713241367.088)).to.equal(0);

      this.plugin.setJobResult(1713241312.223, {test: 1});
      expect(this.plugin.getJobState(1713241312.223)).to.equal(3);

      const result = await this.plugin.getJobResult(1713241312.223);
      expect(result.test).to.equal(1);
    });

    it('should wait for running result', async() => {
      const noresult = await this.plugin.waitRunningResult(1713255077.823);
      expect(noresult).to.equal(null);

      this.plugin.runningCache.set(1713255077.823, {state: 0});
      setTimeout(() => {this.plugin.runningCache.set(1713255077.823, {result: {test:2}, state:3})}, 1000);
      const result = await this.plugin.waitRunningResult(1713255077.823);
      expect(result.test).to.equal(2);
    });
  });
  