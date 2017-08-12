'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

var utils = require('../lib/utils.js');

console.log(utils.getCpuId());

setTimeout(function() {
    process.exit();
},3000);
