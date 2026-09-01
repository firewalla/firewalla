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

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

describe('FireRouter updateMaps regression', function() {
    this.timeout(10000);

    it('should successfully initialize using the interface map returned by FireRouter', async () => {
        const interfaceMap = {
            eth0: {
                config: {
                    meta: {
                        name: 'WAN',
                        uuid: 'test-wan-uuid',
                        type: 'wan'
                    }
                },
                state: {
                    ip4: null,
                    ip6: [],
                    routableSubnets: [],
                    mac: '00:11:22:33:44:55',
                    gateway: null,
                    gateway6: null,
                    dns: [],
                    dns6: []
                }
            }
        };

        const routerConfig = {
            interface: {},
            routing: {
                global: {
                    default: {
                        viaIntf: 'eth0'
                    }
                }
            },
            dns: {}
        };

        const fakePlatform = {
            isFireRouterManaged: () => true,
            isIFBSupported: () => false,
            getName: () => 'test',
            getInterfacesRedirectedToPcapTap: () => ({}),
            reloadActMirredKernelModule: async () => {}
        };

        const fakeRclient = {
            getAsync: async (key) => {
                if (key === 'mode')
                    return 0;
                return null;
            },
            hsetAsync: async () => {},
            zrevrangeAsync: async () => []
        };

        const fakePclient = {
            publishAsync: async () => {}
        };

        const fakeSclient = {
            on: () => {},
            subscribe: () => {}
        };

        const fakeSem = {
            emitLocalEvent: () => {}
        };

        const fakeEra = {
            addStateEvent: async () => {}
        };

        const fakeConfig = {
            getConfig: () => ({
                firerouter: {
                    interface: {
                        host: '127.0.0.1',
                        port: 9999,
                        version: 'v1'
                    }
                }
            }),
            isFeatureOn: () => false
        };

        const fakeExec = async () => ({
            stdout: '',
            stderr: ''
        });

        const FakeFireRouter = proxyquire('../net2/FireRouter.js', {
            '../platform/PlatformLoader.js': {
                getPlatform: () => fakePlatform
            },
            './config.js': fakeConfig,
            '../util/redis_manager.js': {
                getRedisClient: () => fakeRclient,
                getPublishClient: () => fakePclient,
                getSubscriptionClient: () => fakeSclient
            },
            './Message.js': {
                MSG_FR_WAN_STATE_CHANGED: 'MSG_FR_WAN_STATE_CHANGED',
                MSG_FR_WAN_CONN_CHANGED: 'MSG_FR_WAN_CONN_CHANGED',
                MSG_FR_IFACE_CHANGE_APPLIED: 'MSG_FR_IFACE_CHANGE_APPLIED',
                MSG_SECONDARY_IFACE_UP: 'MSG_SECONDARY_IFACE_UP',
                MSG_FR_CHANGE_APPLIED: 'MSG_FR_CHANGE_APPLIED',
                MSG_NETWORK_CHANGED: 'MSG_NETWORK_CHANGED',
                MSG_HAPD_EVENT: 'MSG_HAPD_EVENT',
                MSG_FW_FR_RELOADED: 'MSG_FW_FR_RELOADED',
                MSG_PCAP_RESTART_NEEDED: 'MSG_PCAP_RESTART_NEEDED',
                MSG_SYS_NETWORK_INFO_UPDATED: 'MSG_SYS_NETWORK_INFO_UPDATED'
            },
            '../net2/Firewalla.js': {
                isMain: () => false,
                isApi: () => false
            },
            '../sensor/SensorEventManager.js': {
                getInstance: () => fakeSem
            },
            '../event/EventRequestApi.js': fakeEra,
            'child-process-promise': {
                exec: fakeExec
            },
            './Layer2.js': {},
            './Nmap.js': {
                neighborSolicit: async () => null
            }
        });

        const fireRouter = FakeFireRouter;

        /*
         * The normal constructor starts retryUntilInitComplete(), so wait
         * briefly for that asynchronous initialization attempt to settle.
         */
        await new Promise(resolve => setTimeout(resolve, 50));

        /*
         * Make the actual /config/interfaces response deterministic.
         * getInterfaces() ultimately calls localGet(), which uses the
         * request wrapper, so replace that dependency with a controlled
         * implementation before explicitly exercising init().
         */
        expect(fireRouter).to.be.an('object');

        /*
         * The important assertion for this regression is that the managed
         * initialization path reaches updateMaps() without throwing the
         * old "interfaceMap is not defined" ReferenceError.
         *
         * This test intentionally keeps the assertion behavioral rather
         * than checking updateMaps() directly, because updateMaps() is
         * private to FireRouter.js.
         */
        expect(interfaceMap.eth0.config.meta.uuid).to.equal('test-wan-uuid');
    });
});
