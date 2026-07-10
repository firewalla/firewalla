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

const log = require('../net2/logger.js')(__filename);
const dhcp = require('../extension/dhcp/dhcp.js');

const broadcastOptions = {
  "protocol": "dhcp",
  "port": 67,
  "script": "broadcast-dhcp-discover.nse",
  "scriptArgs": "broadcast-dhcp-discover.timeout=10"
};

const dhcpOptions = {
  "protocol": "dhcp",
  "port": 67,
  "script": "dhcp-discover.nse"
};

describe('Test dhcp', function() {
  this.timeout(1200000);

  beforeEach((done) => {
    done();
  });

  afterEach((done) => {
    done();
  });

  it.skip('should run dhcp discover', async() => {
    const result = await dhcp.broadcastDhcpDiscover('br0', '', '20:6d:31:01:2b:43', broadcastOptions);
    log.debug('broadcast-dhcp-discover', JSON.stringify(result));
    expect(result.Interface).to.be.equal('br0');
  });

  it.skip('should run dhcp discover', async() => {
    const result = await dhcp.dhcpDiscover('192.168.196.1');
    log.debug('dhcp-discover', JSON.stringify(result));
    expect(result.ServerIdentifier).to.be.equal('192.168.196.1');
  });

  it.skip('should run dhcp discover with options', async() => {
    const result = await dhcp.dhcpDiscover('192.168.196.1', 'cc:08:fa:61:cc:8b', dhcpOptions);
    log.debug('dhcp-discover', JSON.stringify(result));
    expect(result.ServerIdentifier).to.be.equal('192.168.196.1');
  });
});
