/*    Copyright 2016 - 2023 Firewalla INC
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
const should = chai.should;
const expect = chai.expect;
const assert = chai.assert;

const CIDRTrie = require('../util/CIDRTrie.js');

describe('CIDRTrie', () => {
  describe('IPv4 match', () => {
    it('return value if cidr matches', (done) => {
      const trie = new CIDRTrie(4);
      trie.add("192.168.0.0/24", 100);
      const result = trie.find("192.168.0.1");
      expect(result).to.equal(100);
      done();
    });

    it('return null if no cidr matches', (done) => {
      const trie = new CIDRTrie(4);
      trie.add("192.168.0.0/24", 100);
      const result = trie.find("192.168.1.1");
      expect(result).to.be.null;
      done();
    });

    it('return value of longest matching cidr', (done) => {
      const trie = new CIDRTrie(4);
      trie.add("192.168.0.0/16", 100);
      trie.add("192.168.1.0/24", 200);
      const result = trie.find("192.168.1.1");
      expect(result).to.equal(200);
      done();
    });
  });

  describe('IPv6 match', () => {
    it('return value if cidr matches', (done) => {
      const trie = new CIDRTrie(4);
      trie.add("2000::/60", 100);
      const result = trie.find("2000::1");
      expect(result).to.equal(100);
      done();
    });

    it('return null if no cidr matches', (done) => {
      const trie = new CIDRTrie(4);
      trie.add("2000::/60", 100);
      const result = trie.find("2010::1");
      expect(result).to.be.null;
      done();
    });

    it('return value of longest matching cidr', (done) => {
      const trie = new CIDRTrie(4);
      trie.add("2000::/60", 100);
      trie.add("2000:0:0:1::/64", 200);
      const result = trie.find("2000:0:0:1::1");
      expect(result).to.equal(200);
      done();
    });
  });
})