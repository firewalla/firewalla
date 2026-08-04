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
const _ = require('lodash');
let expect = chai.expect;

const sysManager = require('../net2/SysManager.js');
const log = require('../net2/logger.js')(__filename);
const fireRouter = require('../net2/FireRouter.js')
const Constants = require('../net2/Constants.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

describe('test sysManager', function(){
    before(async() => {
        sysManager.iptablesReady = true;
        await fireRouter.init();
        await sysManager.updateAsync();
    });

    after(async() => {
    });

    it('should get interface dns', async() => {
        log.debug("get interface eth0 dns", sysManager.getInterface("eth0").dns);
        log.debug("get interface br0 dns", sysManager.getInterface("br0").dns);
    });

    it('should get default dns6', async() => {
       const defaultDns6 = sysManager.myDefaultDns6();
       log.debug("defaultDns6", defaultDns6);
    });

    it('should get my dns6', async() => {
        log.debug("dns6 eth0", sysManager.myDNS6("eth0"));
        log.debug("dns6 br0", sysManager.myDNS6("br0"));
        log.debug("dns6 pppoe0", sysManager.myDNS6("pppoe0"));
     });

    it('should get stats', async() => {
        const orig = await rclient.getAsync(Constants.REDIS_KEY_POLICY_ENFORCE_SPENT);
        await rclient.setAsync(Constants.REDIS_KEY_POLICY_ENFORCE_SPENT, `{"reboot":true,"ts":123}`);
        const data = (await sysManager.getStats()).policyEnforceSpent;
        expect(data.reboot).to.be.true;
        expect(data.ts).to.be.equal(123);
        await rclient.setAsync(Constants.REDIS_KEY_POLICY_ENFORCE_SPENT, orig);
    });
  });
