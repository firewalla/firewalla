'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');

let flat = require('flat');

let a = {
  test: 1,
  test2: {
    a:1,
    b:2
  }
}

console.log(a);
console.log(flat.flatten(a));

let b = {
  test: 1,
  test2: {
    "a.b":1,
    b:2
  }
}

console.log(b)
console.log(flat.flatten(b));
console.log(flat.unflatten(flat.flatten(b)));
