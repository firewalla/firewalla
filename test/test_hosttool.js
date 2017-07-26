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

let redis = require('redis');
let rclient = redis.createClient();

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let HostTool = require('../net2/HostTool');
let hostTool = new HostTool();

describe('Test Host Tool', () => {

  beforeEach((done) => {
    async(() => {
      await (sample.createSampleHost());
      done();
    })();
  });

  afterEach((done) => {
    async(() => {
      await (sample.removeSampleHost());
      done();
    })();
  });

  it('getIPsByMac should return ipv4 and ipv6 addresses', (done) => {
    setTimeout(done, 10000);
    async(() => {
      try {
        let result = await(hostTool.getIPsByMac("F4:0F:24:00:00:01"));
        expect(result.length).to.equal(3);
        expect(result[0]).to.equal("172.17.0.10");
        expect(result[1]).to.equal("fe80::aa07:d334:59a3:1200");
        expect(result[2]).to.equal("fe80::aa07:d334:59a3:1201");
        done();
      } catch(err) {
        assert.fail();
      }
    })();
  })
});