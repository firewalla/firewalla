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

const log = require('../net2/logger.js')(__filename);
const LRU = require('lru-cache');
const _ = require('lodash');
const minimatch = require('minimatch');

class DomainTrie {
  constructor() {
    this.root = new DomainTrieNode();
    this.domainCache = new LRU({max: 1024});
    this.wildcardCheckedDomains = new LRU({max: 1024});
  }

  add(domain, value, suffixMatch = true) {
    const segs = domain.split('.').reverse();
    let node = this.root;
    for (const seg of segs) {
      if (seg.includes("*")) {
        // wildcard match, add to wildcardMatches set on parent node to match wildcard later
        if (!node.wildcardMatches)
          node.wildcardMatches = new Set();
        const separator = domain.indexOf(".", domain.lastIndexOf("*"));
        const prefix = separator === -1 ? domain : domain.substring(0, separator);
        const suffix = separator === -1 ? "" : domain.substring(separator + 1);
        const obj = {prefix, suffix, value};
        node.wildcardMatches.add(obj);
        return;
      }
      if (!node.children[seg])
        node.children[seg] = new DomainTrieNode();
      node = node.children[seg];
    }
    if (suffixMatch) {
      if (!node.suffixMatchValues)
        node.suffixMatchValues = new Set();
      node.suffixMatchValues.add(value);
    } else {
      if (!node.exactMatchValues)
        node.exactMatchValues = new Set();
      node.exactMatchValues.add(value);
    }
    this.domainCache.reset();
  }

  find(domain) {
    if (!domain)
      return null;
    if (this.domainCache.has(domain))
      return this.domainCache.get(domain);
    let wildcardChecked = false;
    let wildcardMatched = false;
    let node = this.root;
    let values = node.suffixMatchValues && node.suffixMatchValues.size > 0 ? node.suffixMatchValues : null;
    let end = domain.length;
    if (!_.isEmpty(node.wildcardMatches) && !this.wildcardCheckedDomains.peek(domain)) { // do not repeatedly check the same domain on wildcards
      wildcardChecked = true;
      if (this._matchWildCard(node, domain))
        wildcardMatched = true;
    }
    for (let begin = domain.length - 1; begin >= 0; begin--) {
      if (domain.charCodeAt(begin) == 46 || begin == 0) { // 46 is '.'
        const seg = domain.substring(begin == 0 ? begin : begin + 1, end);
        end = begin;
        if (!node.children[seg])
          break;
        node = node.children[seg];
        if (!_.isEmpty(node.wildcardMatches) && !this.wildcardCheckedDomains.peek(domain)) {
          wildcardChecked = true;
          if (this._matchWildCard(node, domain))
            wildcardMatched = true;
        }
        if (begin == 0 && node.exactMatchValues && node.exactMatchValues.size > 0 || node.suffixMatchValues && node.suffixMatchValues.size > 0) {
          if (begin === 0 && node.exactMatchValues && node.exactMatchValues.size > 0) {
            values = node.exactMatchValues; // exact match dominates suffix match if both match the whole domain
          } else {
            values = node.suffixMatchValues;
          }
        }
      }
    }
    if (wildcardChecked) {
      this.wildcardCheckedDomains.set(domain, 1);
      if (wildcardMatched) {
        // lookup again to traverse the updated domain trie, it won't match against wildcards
        return this.find(domain);
      }
    }
    if (_.isSet(values)) {
      this.domainCache.set(domain, values);
      return values;
    }
    return null;
  }

  _matchWildCard(node, domain) {
    let matched = false;
    for (const wildcardMatch of node.wildcardMatches) {
      const {prefix, suffix, value} = wildcardMatch;
      if (!prefix || !suffix || !value)
        continue;
      
      const hostPrefix = suffix.length ? domain.substring(0, domain.length - suffix.length - 1) : domain;
      if (minimatch(hostPrefix, prefix)) {
        log.info(`Domain ${domain} matches wildcard ${prefix}.${suffix}, add it to domain trie with value`, value);
        this.add(domain, value, false);
        matched = true;
      }
    }
    return matched;
  }

  clear() {
    this.root = new DomainTrieNode();
    this.domainCache.reset();
    this.wildcardCheckedDomains.reset();
  }
}

class DomainTrieNode {
  constructor() {
    this.suffixMatchValues = null;
    this.exactMatchValues = null;
    this.children = {};
  }
}

module.exports = DomainTrie;