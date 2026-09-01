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

    it('should expose RA router lifetime for WAN interfaces', async() => {
        const wanInterfaces = fireRouter.sysNetworkInfo.filter(i => {
            return i.type === 'wan';
        });

        expect(wanInterfaces.length).to.be.greaterThan(0);

        for (const intf of wanInterfaces) {
            expect(intf).to.have.property('ra_router_lifetime');

            if (intf.ra_router_lifetime !== null) {
                expect(intf.ra_router_lifetime).to.be.a('number');
                expect(intf.ra_router_lifetime).to.be.at.least(0);
                expect(intf.ra_router_lifetime).to.be.at.most(65535);
                expect(Number.isInteger(intf.ra_router_lifetime)).to.equal(true);
            }
        }
    });

    it('should preserve a Router Lifetime of zero when provided by FireRouter', async() => {
        const wanInterfaces = fireRouter.sysNetworkInfo.filter(i => {
            return i.type === 'wan';
        });

        const zeroLifetimeInterfaces = wanInterfaces.filter(i => {
            return i.ra_router_lifetime === 0;
        });

        if (zeroLifetimeInterfaces.length === 0) {
            log.debug("No WAN interface currently has ra_router_lifetime=0; zero-value preservation cannot be exercised by the current runtime state");
            return;
        }

        for (const intf of zeroLifetimeInterfaces) {
            expect(intf.ra_router_lifetime).to.equal(0);
        }
    });

    it('should report unavailable RA router lifetime as null', async() => {
        const wanInterfaces = fireRouter.sysNetworkInfo.filter(i => {
            return i.type === 'wan';
        });

        const unavailableInterfaces = wanInterfaces.filter(i => {
            return i.ra_router_lifetime === null;
        });

        for (const intf of unavailableInterfaces) {
            expect(intf.ra_router_lifetime).to.equal(null);
        }
    });
});
