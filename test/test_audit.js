'use strict'

var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let audit = require('../util/audit.js');

audit.trace("test", "test2");
