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
const getRaRouterLifetime = require('../net2/ra_router_lifetime.js');


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

    it('should handle a bridge with a missing member interface', async () => {
        const bridge = {
            config: {
                meta: {
                    name: 'Test Bridge',
                    uuid: 'test-bridge',
                    type: 'lan'
                },
                intf: ['eth-missing']
            },
            state: {
                mac: '00:11:22:33:44:55',
                ip4: null,
                ip6: [],
                routableSubnets: []
            }
        };

        const networkInfos = await fireRouter.generateNetworkInfo({
            br0: bridge
        });

        expect(networkInfos).to.have.lengthOf(1);
        expect(networkInfos[0]).to.have.property('name', 'br0');
        expect(networkInfos[0]).to.not.have.property('vid');
    });

    it('should preserve zero ra_router_lifetime in generated network info', async () => {
        const wan = {
            config: {
                meta: {
                    name: 'Test WAN',
                    uuid: 'test-wan',
                    type: 'wan'
                }
            },
            state: {
                ra_router_lifetime: 0,
                mac: '00:11:22:33:44:55',
                ip4: null,
                ip6: [],
                routableSubnets: []
            }
        };

        const networkInfos = await fireRouter.generateNetworkInfo({
            testwan: wan
        });

        expect(networkInfos).to.have.lengthOf(1);
        expect(networkInfos[0]).to.have.property('name', 'testwan');
        expect(networkInfos[0]).to.have.property('ra_router_lifetime', 0);
    });

    it('should preserve zero ra_router_lifetime in generated network info', async () => {
        const wan = {
            config: {
                meta: {
                    name: 'Test WAN',
                    uuid: 'test-wan',
                    type: 'wan'
                }
            },
            state: {
                ra_router_lifetime: 0,
                mac: '00:11:22:33:44:55',
                ip4: null,
                ip6: [],
                routableSubnets: []
            }
        };

        const networkInfos = await fireRouter.generateNetworkInfo({
            testwan: wan
        });

        expect(networkInfos).to.have.lengthOf(1);
        expect(networkInfos[0]).to.have.property('name', 'testwan');
        expect(networkInfos[0]).to.have.property('ra_router_lifetime', 0);

        const serialized = JSON.stringify(networkInfos[0]);
        const parsed = JSON.parse(serialized);

        expect(parsed).to.have.property('ra_router_lifetime', 0);
    });

    it('should include ra_router_lifetime in generated network info', () => {
        expect(fireRouter.sysNetworkInfo.length).to.be.greaterThan(0);
        for (const intf of fireRouter.sysNetworkInfo) {
            expect(intf).to.have.property('ra_router_lifetime');
            expect(intf.ra_router_lifetime === null || Number.isInteger(intf.ra_router_lifetime)).to.equal(true);

            if (intf.ra_router_lifetime !== null) {
                expect(intf.ra_router_lifetime).to.be.at.least(0);
                expect(intf.ra_router_lifetime).to.be.at.most(65535);
            }
        }
    });

    describe('RA router lifetime', function(){
        function makeInterface(type, value) {
            const intf = {
                config: {
                    meta: {
                        type: type
                    }
                },
                state: {}
            };

            if (value !== undefined)
                intf.state.ra_router_lifetime = value;

            return intf;
        }

        it('preserves zero exactly for a WAN interface', () => {
            expect(getRaRouterLifetime(makeInterface('wan', 0))).to.equal(0);
        });

        it('preserves the maximum 16-bit lifetime exactly for a WAN interface', () => {
            expect(getRaRouterLifetime(makeInterface('wan', 65535))).to.equal(65535);
        });

        it('propagates a normal positive lifetime for a WAN interface', () => {
            expect(getRaRouterLifetime(makeInterface('wan', 1800))).to.equal(1800);
        });

        it('maps invalid WAN lifetime values to null', () => {
            const invalidValues = [
                -1,
                1.5,
                65536,
                '1800',
                undefined
            ];
            for (const value of invalidValues) {
                expect(getRaRouterLifetime(makeInterface('wan', value))).to.equal(null);
            }
        });

        it('maps a missing state object to null', () => {
            const intf = {
                config: {
                    meta: {
                        type: 'wan'
                    }
                }
            };

            expect(getRaRouterLifetime(intf)).to.equal(null);
        });

        it('maps a non-WAN interface to null', () => {
            expect(getRaRouterLifetime(makeInterface('lan', 1800))).to.equal(null);
        });
    });
});
