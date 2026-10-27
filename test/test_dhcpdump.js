/*    Copyright 2026 Firewalla Inc.
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

// dhcpdump.js pulls in SysManager at load time; parseEvent does not use it,
// so stub it out to keep this a pure parsing test.
const sysManagerPath = require.resolve('../net2/SysManager.js');
const savedSysManager = require.cache[sysManagerPath];
require.cache[sysManagerPath] = { id: sysManagerPath, filename: sysManagerPath, loaded: true, exports: {} };
const DHCPDump = require('../extension/dhcpdump/dhcpdump.js');
if (savedSysManager) {
  require.cache[sysManagerPath] = savedSysManager;
} else {
  delete require.cache[sysManagerPath];
}

function event(hostName) {
  return [
    'IP: 0.0.0.0 (2:42:ac:11:0:2) > 255.255.255.255 (ff:ff:ff:ff:ff:ff)',
    '  OPTION:  53 (  1) DHCP message type         3 (DHCPREQUEST)',
    `  OPTION:  12 ( ${hostName.length}) Host name                 ${hostName}`,
    '  OPTION:  55 (  3) Parameter Request List    1 (Subnet mask)',
  ].join('\n');
}

describe('DHCPDump.parseEvent', () => {
  const dump = Object.create(DHCPDump.prototype);

  it('parses a single-word hostname', () => {
    expect(dump.parseEvent(event('iPhone')).name).to.equal('iPhone');
  });

  it('keeps spaces inside the hostname', () => {
    const obj = dump.parseEvent(event('Living Room TV'));
    expect(obj.name).to.equal('Living Room TV');
    expect(obj.mtype).to.equal('DHCPREQUEST');
  });

  it('trims trailing whitespace and CR', () => {
    expect(dump.parseEvent(event('Living Room TV  ').replace(/\n/g, '\r\n')).name).to.equal('Living Room TV');
  });

  it('does not set a name for a blank hostname', () => {
    const obj = dump.parseEvent(event(''));
    expect(obj.name).to.equal(undefined);
    expect(obj.mac).to.equal('02:42:AC:11:00:02');
  });
});
