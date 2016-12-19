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
