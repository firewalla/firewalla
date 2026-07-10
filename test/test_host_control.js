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
let should = chai.should();

let sample = require('./sample_data');

let spoof = require('../net2/Spoofer');

let rclient = require('../util/redis_manager').getRedisClient();

describe.skip('Test control features on host', () => {
  
  beforeEach((done) => {
    sample.createSampleHost()
      .then(() => done())
  });
  
  afterEach((done) => {
    sample.removeSampleHost()
      .then(() => done())
  })
  
  it('should block host to access internet when "internet off" is tapped');
  
  it('should exclude host from montioring when "monitor off" is tapped');
  
  it('should update redis database when spoof', (done) => {
    spoof.newSpoof("172.17.0.10")
      .then(() => {
        rclient.sismemberAsync("monitored_hosts", "172.17.0.10")
          .then((result) => {
            result.should.equal(1)

            rclient.sismemberAsync("unmonitored_hosts", "172.17.0.10")
              .then((result) => {
                result.should.equal(0)
              })
          })
      });
    done();
  });

  it('should update redis database when unspoof', (done) => {
    /*
    spoof.newUnspoof("172.17.0.10")
      .then(() => {
        rclient.sismemberAsync("monitored_hosts", "172.17.0.10")
          .then((result) => {
            result.should.equal(0)

            rclient.sismemberAsync("unmonitored_hosts", "172.17.0.10")
              .then((result) => {
                result.should.equal(1)
              })
          })
      });
    */
    done();
  })
});
