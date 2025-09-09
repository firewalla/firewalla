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

"use strict";

const net = require('net')
const log = require('../net2/logger.js')(__filename);
const { Address6 } = require('ip-address')

// these functions are not returning correct results and should not be used anymore
const iptool = require('ip')
delete iptool.isPublic
delete iptool.isPrivate

class IPUtil {
  network = {
    4: {
      byteSize: 4,
      maskLen: 32n,
      privateNetworks: [
        [ 167772160n,  184549375n], // 10.0.0.0/8
        [2130706432n, 2147483647n], // 127.0.0.0/8
        [2851995648n, 2852061183n], // 169.254.0.0/16
        [2886729728n, 2887778303n], // 172.16.0.0/12
        [3232235520n, 3232301055n], // 192.168.0.0/16
      ]
    },
    6: {
      byteSize: 16,
      maskLen: 128n,
      privateNetworks: [
        [              1n,                     1n ], // ::1
        [ 0xfc00n << 112n, (0xfe00n << 112n) - 1n ], // fc00::/7    ULAs
        [ 0xfe80n << 112n, (0xfec0n << 112n) - 1n ], // fe80::/10   link local
      ]
    }
  }

  toBigInt(n) {
    if (Array.isArray(n)) {
      return n.reduce((p, c) => (p << 32n) + BigInt(c), 0n)
    }
    else {
      return BigInt(n)
    }
  }

  ntoaBigInt(n, fam) {
    if (typeof value !== 'bigint')
      n = this.toBigInt(n)

    if (n < (1n << 32n)) {
      if (n < 0n)
        return null
      else if (!fam)
        fam = 4
    } else if (n > (1n << 128n) - 1n)
      return null
    else if (fam == 4)
      return null
    else
      fam = 6

    const sections = fam == 4 ? 4 : 8
    const sectionMask = fam == 4 ? 0xFFn : 0xFFFFn
    const sectionBits = fam == 4 ? 8n : 16n
    const parts = Array(sections)

    for (let i = 0; i < sections; i++) {
      if (n > 0n) {
        parts[i] = n & sectionMask
        n >>= sectionBits
      } else
        parts[i] = 0n
    }

    if (fam == 4) {
      return parts.reverse().join('.')
    } else {
      // no need to simplify zeros here
      return parts.reverse().map(n=>n.toString(16)).join(':')
    }
  }

  atonBigInt(str, fam) {
    if (!fam) fam = net.isIP(str)
    if (!fam) return NaN

    const sectionBits = fam == 4 ? 8n : 16n
    // ip-address does come with bigint lib jsbn, but that's too complicated
    const parts = fam == 4 ? str.split('.') : new Address6(str).parsedAddress.map(hex => '0x'+hex)

    return parts.reduce( (prev, curr) => (prev << sectionBits) + BigInt(curr), 0n )
  }

  numberToCIDRs(start, end, fam = 4) {
    const resultArray = []
    const maxMaskLen = this.network[fam].maskLen

    // use BigInt for readability, performance penalty is very little
    start = this.toBigInt(start)
    end = this.toBigInt(end)

    if (start > end) return []

    while (start <= end) {
      const ipStr = this.ntoaBigInt(start, fam)

      // number with the least significent none 0 bit of start
      // also the biggest CIDR size starting from start
      let size
      if (start == 0n) {
        // a subnet of maxMaskLen makes no sense, start with 1 less bit
        size = 1n << (maxMaskLen - 1n)
      } else {
        size = start & -start
      }

      // if start+size exceeds end, cut size in half
      while (start + size - 1n > end && size > 0n) {
        size >>= 1n
      }
      start += size

      // get mask (prefix) length
      let maskLen = maxMaskLen
      while (size > 1n) {
        size >>= 1n
        maskLen --
      }

      resultArray.push(ipStr + '/' + maskLen)
    }

    return resultArray
  }

  isPrivate(ipStr) {
    const fam = net.isIP(ipStr)
    if (fam == 0) return false

    const ipNum = this.atonBigInt(ipStr)

    return this.network[fam].privateNetworks.some(net => ipNum >= net[0] && ipNum <= net[1])
  }

  isPublic(ipStr) {
    const fam = net.isIP(ipStr)
    if (fam == 0) return false

    const ipNum = this.atonBigInt(ipStr)

    return this.network[fam].privateNetworks.every(net => ipNum < net[0] || ipNum > net[1])
  }
}

module.exports = new IPUtil()
