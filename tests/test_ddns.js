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

let SysManager = require('../net2/SysManager');
let sysManager = new SysManager('info');

let bootstrap = require('../net2/Bootstrap');

let BoneSensor = require('../sensor/BoneSensor');
let boneSensor = new BoneSensor();

describe('DDNS', function () {
  this.timeout(10000);

  beforeEach((done) => {
    async(() => {
      await (rclient.delAsync("sys:network:info"));
      await (bootstrap.bootstrap());
      done();
    })();
  });

  it('should get DDNS correctly', (done) => {
    await (boneSensor.checkIn());
    let matchResult = sysManager.ddns.match(/.d.firewalla.com/);
    expect(matchResult.constructor.name).to.equal('Array');
    done();
  })
});
