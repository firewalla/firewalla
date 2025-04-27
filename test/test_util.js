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

const { versionCompare, difference, stripObject } = require('../util/util.js');

describe('Test difference', () => {
    it('should compare the different keys', () => {
        const obj1 = {"newDeviceTag":{"state":false,"tag":0},"app":{"family":{"state":false,"mode":"native","setting":{"gamble":true,"apple_privacy_relay":true,"porn":true,"vpn":true,"doh":true}}},"device_service_scan":true,"ipv6in4":false,"safeSearch":{"state":false},"vulScan":false,"qos":{"state":false,"qdisc":"fq_codel"},"adblock":false,"vpn":{"netmask":"255.255.255.0","state":false,"externalPort":1194,"localPort":1194,"protocol":"udp","serverNetwork":"10.34.191.0"},"vpnClient":{"state":false},"doh":{"state":false},"unbound":{"state":false},"adblock_ext":{"userconfig":{"ads-adv":"on"},"fastmode":true},"monitor":true,"ntp_redirect":{"state":false},"dnsmasq":{"state":false},"family":false,"acl":true,"notify":{"state":1},"enhancedSpoof":false,"vpnClientInited":false,"shadowsocks":{"state":false},"scisurf":{"state":false},"externalAccess":{"state":false}};
        const obj2 = {"newDeviceTag":{"state":false,"tag":0},"app":{"family":{"state":false,"mode":"native","setting":{"gamble":true,"apple_privacy_relay":true,"porn":true,"vpn":true,"doh":true}}},"device_service_scan":true,"ipv6in4":false,"safeSearch":{"state":false},"vulScan":false,"qos":{"state":false,"qdisc":"fq_codel"},"adblock":false,"vpn":{"netmask":"255.255.255.0","state":false,"externalPort":1194,"localPort":1194,"protocol":"udp","serverNetwork":"10.34.191.0"},"vpnClient":{"state":false},"doh":{"state":false},"unbound":{"state":false},"adblock_ext":{"userconfig":{"ads":"on"},"fastmode":true},"monitor":true,"ntp_redirect":{"state":false},"dnsmasq":{"state":false},"family":false,"acl":true,"notify":{"state":1},"enhancedSpoof":false,"vpnClientInited":false,"shadowsocks":{"state":false},"scisurf":{"state":false},"externalAccess":{"state":false}}
        expect(difference(obj2, obj1)).to.be.eql(["adblock_ext"]);
    })

    it('should compare multiple keys', () => {
        const obj1 = {"newDeviceTag":{"state":false,"tag":0, "test":[1,2,3]},"app":{"family":{"state":false,"mode":"native","setting":{"gamble":true,"apple_privacy_relay":true,"porn":true,"vpn":true,"doh":true}}},"device_service_scan":true,"ipv6in4":false,"safeSearch":{"state":false},"vulScan":false,"qos":{"state":false,"qdisc":"fq_codel"},"adblock":false,"vpn":{"netmask":"255.255.255.0","state":false,"externalPort":1194,"localPort":1194,"protocol":"udp","serverNetwork":"10.34.191.0"},"vpnClient":{"state":false},"doh":{"state":false},"unbound":{"state":false},"adblock_ext":{"userconfig":{"ads-adv":"on"},"fastmode":true},"monitor":true,"ntp_redirect":{"state":false},"dnsmasq":{"state":false},"family":false,"acl":true,"notify":{"state":1},"enhancedSpoof":false,"vpnClientInited":false,"shadowsocks":{"state":false},"scisurf":{"state":false},"externalAccess":{"state":false}};
        const obj2 = {"newDeviceTag":{"state":false,"tag":0, "test":[2,3]},"app":{"family":{"state":false,"mode":"native","setting":{"gamble":true,"apple_privacy_relay":true,"porn":true,"vpn":true,"doh":true}}},"device_service_scan":true,"ipv6in4":false,"safeSearch":{"state":false},"vulScan":false,"qos":{"state":true,"qdisc":"fq_codel"},"adblock":false,"vpn":{"netmask":"255.255.255.0","state":false,"externalPort":1194,"localPort":1194,"protocol":"udp","serverNetwork":"10.34.191.0"},"vpnClient":{"state":false},"doh":{"state":false},"unbound":{"state":false},"adblock_ext":{"userconfig":{"ads":"on"},"fastmode":true},"monitor":true,"ntp_redirect":{"state":false},"dnsmasq":{"state":true},"family":false,"acl":true,"notify":{"state":1},"enhancedSpoof":false,"vpnClientInited":false,"shadowsocks":{"state":false},"scisurf":{"state":false},"externalAccess":{"state":false}}
        expect(difference(obj2, obj1)).to.be.eql(['newDeviceTag', 'qos', 'adblock_ext', 'dnsmasq']);
    })

    it('should compare deleted keys', () => {
        const obj1 = {"newDeviceTag":{"state":false,"tag":0, "test":[1,2,3]},"shadowsocks":{"state":false},"scisurf":{"state":false},"externalAccess":{"state":false}};
        const obj2 = {"newDeviceTag":{"state":false,"tag":0},"shadowsocks":{"state":false},"scisurf":1,"externalAccess":{"state":false}, "options": {"ssl": true}, "monitor": true};
        expect(difference(obj2, obj1)).to.be.eql(['newDeviceTag', 'scisurf', 'options', 'monitor']);
    })

    it('should compare null', () => {
        const obj1 = {"newDeviceTag":{"state":false,"tag":0, "test":[1,2,3]},"shadowsocks":{"state":false},"scisurf":{"state":false},"externalAccess":{"state":false}};
        expect(difference(null, obj1)).to.be.eql(['newDeviceTag', 'shadowsocks', 'scisurf', 'externalAccess']);
        expect(difference({}, obj1)).to.be.eql(['newDeviceTag', 'shadowsocks', 'scisurf', 'externalAccess']);
        expect(difference({}, [])).to.be.eql([]);
        expect(difference(null, null)).to.be.eql([]);
        expect(difference(obj1, null)).to.be.eql(['newDeviceTag', 'shadowsocks', 'scisurf', 'externalAccess']);
    })

});

describe('Test versionCompare', () => {
    it('should compare versions', () => {
        expect(versionCompare("", "1.62"), true);
        expect(versionCompare("1.25", "1.62"), true);
        expect(versionCompare("1.64 (13)", "1.62"), false);
        expect(versionCompare("1.62 (13)", "1.62"), false);
        expect(versionCompare("1.62", "1.62"), false);
        expect(versionCompare("1.62.10", "1.62.4"), false);
    });
});

describe('test utils', () => {
    it('should strip object', () => {
        let a = {"a":"","b":0,"c":null,"d":"","f":1};
        expect(Object.keys(stripObject(a, ["e", "f"], ["a", "b", "c"]))).to.be.eql(["b", "d"]);
    });
});
