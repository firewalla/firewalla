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

let Bootstrap = require('../net2/Bootstrap');

let redis = require('redis');
let rclient = redis.createClient();

let license = require('../util/license');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');
let intelSample = require('./sample_data_intel');

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let bootstrap = require('../net2/Bootstrap');

describe('Bone', function () {
  this.timeout(10000);

  describe('.intel', function () {
    before((done) => {
      async(() => {
        await (license.writeLicenseAsync(sample.sampleLicense));
        await (Bootstrap.bootstrap());
        done();
      })();
    })

    it('should load intel correctly (netflix)', (done) => {
      let sampleData = {flowlist:intelSample.netflix, hashed: 1};
      let bone = require("../lib/Bone.js");

      async(() => {
        let intelResult = await (bone.intelAsync("*", "check", sampleData));
        console.log(intelResult);
        done();
      })();
    })

    it('should load intel correctly (pinterest)', (done) => {
      let sampleData = {flowlist:intelSample.pinterest, hashed: 1};
      let bone = require("../lib/Bone.js");

      async(() => {
        let intelResult = await (bone.intelAsync("*", "check", sampleData));
        console.log(intelResult);
        done();
      })();
    })
  })

});
