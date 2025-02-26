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

'use strict';

let chai = require('chai');
const _ = require('lodash');
let expect = chai.expect;

const fireRouter = require('../net2/FireRouter.js')
const log = require('../net2/logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();


describe('Test firerouter config', function(){
    this.timeout(10000);

    before(async () => {
        await fireRouter.init();
    });

    after(async () => {

    });
  
    it('should generate network info', async() => {
        log.debug("eth0 network config", fireRouter.sysNetworkInfo.filter(i => i.name == "eth0" || i.name == "pppoe0"));
        expect(fireRouter.sysNetworkInfo.length).to.be.not.equal(0);
    });
  });
