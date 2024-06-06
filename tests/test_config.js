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

const fc = require('../net2/config.js');
const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient()

describe('Test AlarmManager2', function(){
    this.timeout(30000);
  
    beforeEach((done) => {
      (async() => {
        this.config = await fc.getMspConfig('', true);
        log.debug('mspConfig', JSON.stringify(this.config));
        done();
      })();
    });
  
    afterEach((done) => {
      done();
    });

    it('should get msp config', async() => {
        const mspc = await fc.getMspConfig('', false);
        expect(mspc.alarm).to.eql(this.config.alarm)
    });
  });