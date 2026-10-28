/*    Copyright 2016 Firewalla LLC
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
let should = chai.should;
let expect = chai.expect;
let assert = chai.assert;

let sample = require('./sample_data');

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

describe.skip('Test Host Tool', () => {

  beforeEach((done) => {
    (async() =>{
      await sample.createSampleHost();
      done();
    })();
  });

  afterEach((done) => {
    (async() =>{
      await sample.removeSampleHost();
      done();
    })();
  });

  describe('.getMacByIP', () => {
    it('should get the right mac address by ip', (done) => {
      (async() =>{
        let macAddress = await hostTool.getMacByIP(sample.hostIP);
        expect(macAddress).to.equal(sample.hostMac)
        done();
      })();
    })
  });

  describe('.getIPsByMac', function() {
    this.timeout(10000);

    it('getIPsByMac should return ipv4 and ipv6 addresses', (done) => {
      (async() =>{
        try {
          let result = await hostTool.getIPsByMac("F4:0F:24:00:00:01");
          expect(result.length).to.equal(3);
          expect(result[0]).to.equal("172.17.0.10");
          expect(result[1]).to.equal("fe80::aa07:d334:59a3:1200");
          expect(result[2]).to.equal("fe80::aa07:d334:59a3:1201");
        } catch(err) {
          assert.fail();
        }
        done();
      })();
    })
  })

  describe('.getAllIPs', () => {
    it('getAllIPs should return all ip address in the network', (done) => {
      (async() =>{
        let allIPs = await hostTool.getAllIPs();
        expect(allIPs.length).to.above(1);
        expect(allIPs.length).to.below(4);
        allIPs.forEach((ip_mac) => {
          if(ip_mac.ip === sample.hostIP) {
            expect(ip_mac.mac).to.equal(sample.hostMac);
          }

          if(ip_mac.ip === sample.hostIP2) {
            expect(ip_mac.mac).to.equal(sample.hostMac2);
          }
        })
        done();
      })();
    })
  })
});
