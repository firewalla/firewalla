/*    Copyright 2016-2025 Firewalla Inc.
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

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

describe('test ap assets', function(){
    this.timeout(3000);

    it('should enrich ap host ipv4', async() => {
        const hosts = [{"ip":"192.168.20.211","ipv6":[],"mac":"AA:BB:CC:DD:EE:FF"},{"ip":"192.168.20.122","ipv6":[],"mac":"AA:11:CC:22:EE:33"}];
        const assets = {"AA:BB:CC:DD:EE:FF":{"mac":"AA:BB:CC:DD:EE:FF","name":"Office","model":"fwap-F",
            "addrs":{"br-lan1":{"ip4":"192.168.20.211","mac":"20:6D:31:61:01:96"},"br-lan0":{"ip4":"192.168.10.137","mac":"20:6D:31:61:01:96"}}}};
        hostManager._enrichApInfo(hosts, assets);
        expect(hosts[0].ip).to.equal('192.168.10.137');

    });

});
