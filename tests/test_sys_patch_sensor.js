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
const _ = require('lodash');
const SysPatchSensor = require('../sensor/SysPatchSensor');
const Constants = require('../net2/Constants.js');
const rclient = require('../util/redis_manager').getRedisClient();
const log = require('../net2/logger.js')(__filename);


describe('Test ActionPlugin', function() {
    this.timeout(30000);

    before((done) => {
      (async() =>{
        done();
      })();
    });

    after((done) => {
      (async() => {
        done();
      })();
    });

    it('should run callhome scripts', async() => {
        expect(await SysPatchSensor.cmdCallhome(Constants.SCRIPT_POST_INIT_PAIRING)).to.be.empty;
        expect(await SysPatchSensor.cmdCallhome(Constants.SCRIPT_POST_FIRST_CHECKIN)).to.be.empty;
        expect(await SysPatchSensor.cmdCallhome("fake")).to.be.empty;
    })
});