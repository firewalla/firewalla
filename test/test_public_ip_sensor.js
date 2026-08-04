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

let rclient = require('../util/redis_manager').getRedisClient();

let sem = require('../sensor/SensorEventManager.js').getInstance();

let PublicIPSensor = require('../sensor/PublicIPSensor');
let s = new PublicIPSensor();

describe.skip('Test public ip sensor', () => {

  beforeEach((done) => {
    (async() =>{
      await rclient.hdelAsync("sys:network:info", "publicIp");
      sem.on("PublicIP:Updated", (event) => {
        this.ip = event.ip;
      });
      done();  
    })();
  });

  afterEach((done) => {
    done();
  });

  it('should have redis publicIp key', (done) => {
    (async() =>{
      try {
        await s.job();
        let result = await rclient.hgetAsync("sys:network:info", "publicIp");
        expect(result).to.not.null;
        expect(result).to.not.equal("");
        expect(this.ip).to.not.null;
        done();
      } catch(err) {
        assert.fail();
      }
    })();
  })
});
