/*    Copyright 2016-2019 Firewalla INC
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
var _ = require('lodash');

function isPatternMatch(str, pattern) {
  return _.isRegExp(pattern) ? pattern.test(str) : pattern === str;
}

function patternMatchIndexOf(str, pattern, start) {
  var offset = start;
  while (!isPatternMatch(str.charAt(offset), pattern) &&
         offset < str.length) {
    offset++;
  }
  return offset;
}

class StringCursor {
  constructor(str) {
    this._str = str;
    this._offset = 0;
  }

  remaining() {
    return this._str.length - this._offset;
  }

  clear() {
    this._offset = 0;
  }

  peek(length) {
    return this._str.slice(this._offset, this._offset + length);
  }

  skip(length) {
    this._offset = Math.min(this._offset + length, this._str.length);
  }

  chomp(length) {
    var slice = this._str.slice(this._offset, this._offset + length);
    this._offset = Math.min(this._offset + length, this._str.length);
    return slice;
  }

  chompWhile(pattern) {
    var lastFoundOffset = this._offset;
    while (isPatternMatch(this._str.charAt(lastFoundOffset), pattern) &&
           lastFoundOffset < this._str.length) {
      lastFoundOffset++;
    }

    var slice = this._str.slice(this._offset, lastFoundOffset);
    this._offset = lastFoundOffset;
    return slice;
  }

  chompUntil(pattern) {
    var foundOffset = patternMatchIndexOf(this._str, pattern, this._offset);
    var slice = this._str.slice(this._offset, foundOffset);
    this._offset = foundOffset + 1;
    return slice;
  }

  chompUntilBefore(pattern) {
    var foundOffset = patternMatchIndexOf(this._str, pattern, this._offset);
    var slice = this._str.slice(this._offset, foundOffset);
    this._offset = foundOffset;
    return slice;
  }

  chompUntilIfExists(pattern) {
    var foundOffset = patternMatchIndexOf(this._str, pattern, this._offset);
    if (foundOffset === this._str.length) {
      return null;
    }

    var slice = this._str.slice(this._offset, foundOffset);
    this._offset = foundOffset + 1;
    return slice;
  }

  chompRemaining() {
    var slice = this._str.slice(this._offset);
    this._offset = this._str.length;
    return slice;
  }

  divideRemaining(length) {
    var slices = [];
    while (this.remaining()) {
      slices.push(this.chomp(length));
    }
    return slices;
  }
}

module.exports = StringCursor;
