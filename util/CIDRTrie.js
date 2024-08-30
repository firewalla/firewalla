/*    Copyright 2016-2023 Firewalla INC
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

let log = require('../net2/logger.js')(__filename, 'info');
const { Address4, Address6 } = require('ip-address');

class CIDRTrie {
  constructor(af = 4) {
    this.root = new TrieNode();
    this.af = af;
  }

  add(cidr, val) {
    let maskLen = cidr.split('/')[1];
    if (isNaN(maskLen))
      maskLen = this.af == 4 ? 32 : 128;
    else
      maskLen = Number(maskLen);
    const addr = this.af == 4 ? new Address4(cidr) : new Address6(cidr);
    if (!addr.isValid())
      return;
    // bit-wise manipulation based on byte array is more efficient than using base-2 string
    const byteArray = this.af == 4 ? addr.toArray() : addr.toByteArray();
    let cur = this.root;
    let arrIdx = 0;
    for (let offset = this.af == 4 ? 31 : 127; offset > (this.af == 4 ? 31 : 127) - maskLen; offset--) {
      const bit = (byteArray[arrIdx] >> (offset % 8)) & 1;
      if (cur.children[bit] == null)
        cur.children[bit] = new TrieNode();
      cur = cur.children[bit];
      if (offset % 8 == 0)
        arrIdx++;
    }
    cur.val = val;
  }

  find(ip) {
    // find the longest-matching node and return its val
    const addr = this.af == 4 ? new Address4(ip) : new Address6(ip);
    if (!addr.isValid())
      return null;
    const byteArray = this.af == 4 ? addr.toArray() : addr.toByteArray();
    let cur = this.root;
    let result = null;
    let arrIdx = 0;
    for (let offset = this.af == 4 ? 31 : 127; offset >= 0; offset--) {
      const bit = (byteArray[arrIdx] >> (offset % 8)) & 1;
      if (cur.children[bit] == null)
        break;
      cur = cur.children[bit];
      if (cur.val !== null)
        result = cur.val;
      if (offset % 8 == 0)
        arrIdx++;
    }
    return result
  }
}

class TrieNode {
  constructor() {
    this.val = null;
    this.children = [null, null];
  }
}

module.exports = CIDRTrie;