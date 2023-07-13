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

const LRU = require('lru-cache');
const _ = require('lodash');

class DomainTrie {
  constructor() {
    this.root = new DomainTrieNode();
    this.domainCache = new LRU({max: 1024});
  }

  add(domain, value) {
    const segs = domain.split('.').reverse();
    let node = this.root;
    for (const seg of segs) {
      if (!node.children[seg])
        node.children[seg] = new DomainTrieNode();
      node = node.children[seg];
    }
    node.values.add(value);
  }

  find(domain) {
    if (this.domainCache.has(domain))
      return this.domainCache.get(domain);
    let node = this.root;
    let values = node.values.size > 0 ? node.values : null;
    let end = domain.length;
    for (let begin = domain.length - 1; begin >= 0; begin--) {
      if (domain.charCodeAt(begin) == 46 || begin == 0) { // 46 is '.'
        const seg = domain.substring(begin == 0 ? begin : begin + 1, end);
        end = begin;
        if (!node.children[seg])
          break;
        node = node.children[seg];
        if (node.values.size > 0)
          values = node.values;
      }
    }
    if (_.isSet(values)) {
      this.domainCache.set(domain, values);
      return values;
    }
    return null;
  }

  clear() {
    this.root = new DomainTrieNode();
    this.domainCache.reset();
  }
}

class DomainTrieNode {
  constructor() {
    this.values = new Set();
    this.children = {};
  }
}

module.exports = DomainTrie;