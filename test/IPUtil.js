/*    Copyright 2025 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;

const ipUtil = require('../util/IPUtil.js')

describe('ip utilities', () => {
  const invalidIPs = [ '127.1', '127.0.1', '127.00.0x1', '127.0.0x0.1', '012.1.2.3', '01200034567', 'f::0::1' ]

  it('should covert IP betwwen string and BigInt correctly', async() => {
    const data = [
      [ '192.168.0.1', 3232235521n ],
      [ '1.1.1.1', 16843009n ],
      [ '3.193.182.100', 63026788n ],
      [ '183.47.81.140', 3073331596n ],
      [ '9a8:52c1:6983:626e:a538:163e:bfcb:589e', 12837036315575718734292514199405549726n ],
    ]
    for (const pair of data) {
      expect(ipUtil.atonBigInt(pair[0])).to.equal(pair[1])
      expect(ipUtil.ntoaBigInt(pair[1])).to.equal(pair[0])
    }
    // ntoa doesn't do simplification
    expect(ipUtil.atonBigInt('fc00::')).to.equal(334965454937798799971759379190646833152n)
    expect(ipUtil.ntoaBigInt(334965454937798799971759379190646833152n)).to.equal('fc00:0:0:0:0:0:0:0')

    // ambiguous when converting back
    expect(ipUtil.atonBigInt('::1')).to.equal(1n)
    expect(ipUtil.ntoaBigInt(1, 6)).to.equal('0:0:0:0:0:0:0:1')
  });

  it('aotn should return NaN for invalid input', async() => {
    for (const ip of invalidIPs) {
      expect(ipUtil.atonBigInt(ip)).to.be.NaN
    }
  });

  it('aotn should parse arbitrary IP correctly', async() => {
    const data = [
      [ 'fe80::0001', 338288524927261089654018896841347694593n ],
      [ '000:0:0000::01', 1n ],
      [ '000:0:0000:0:000:0:00:001', 1n ],
      [ '::fFFf:127.0.0.1', 281472812449793n ],
    ]
    for (const pair of data) {
      expect(ipUtil.atonBigInt(pair[0])).to.equal(pair[1])
    }
  });

  it('nota should return null for invalid input', async() => {
    expect(ipUtil.ntoaBigInt(-1)).to.be.null
    expect(ipUtil.ntoaBigInt(1n << 32n, 4)).to.be.null
    expect(ipUtil.ntoaBigInt(1n << 128n, 6)).to.be.null
  });

  it('isPublic & isPrivate should both return false for invalid input', async() => {
    for (const ip of invalidIPs) {
      expect(ipUtil.isPublic(ip)).to.be.false
      expect(ipUtil.isPrivate(ip)).to.be.false
    }
  });

  it('isPublic & isPrivate should return opposite for valid IP', async() => {
    const data = [
      [ '10.0.1.255', false ],
      [ '192.168.0.1', false ],
      [ '169.254.30.5', false ],
      [ '172.31.255.255', false ],
      [ '172.32.0.1', true ],
      [ '1.1.1.1', true ],
      [ '3.193.182.100', true ],
      [ '::1', false ],
      [ 'fe80::fe31:1a3f', false ],
      [ 'fc00::', false ],
      [ 'fe00::', true ],
      [ '9a8:52c1:6983:626e:a538:163e:bfcb:589e', true ],
    ]
    for (const pair of data) {
      expect(ipUtil.isPublic(pair[0])).to.equal(pair[1])
      expect(ipUtil.isPrivate(pair[0])).to.equal(!pair[1])
    }
  });
})
