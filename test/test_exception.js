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
let assert = chai.assert;

let sample = require('./sample_data');

let Spoof = require('../net2/Spoofer');
let spoof = new Spoof("eth0", true, true);

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

describe('Test control features on host', () => {

  beforeEach((done) => {
    sample.createSampleException()
      .then(() => done())
  });

  afterEach((done) => {
    sample.removeSampleException()
      .then(() => done())
  })

  it('should prevent from alarming if covered by exception', (done) => {
    sample.createSampleVideoAlarm()
      .then(() => {
        assert.fail();
      }).catch((err) => {
      err.toString().should.equal("Error: alarm is covered by exceptions");
      done();
    })
  })
});