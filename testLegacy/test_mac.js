'use strict'

var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

var mac = require('mac-lookup')

mac.lookup('f4:0f:24:34:73:64', (err, name) => {
  console.log(err, name);
});
