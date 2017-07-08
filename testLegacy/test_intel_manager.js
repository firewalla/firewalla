'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let log = require('../net2/logger.js')(__filename, 'info');

let util = require('util');

let IM = require('../net2/IntelManager.js')
let im = new IM('info');

im._location("31.192.120.36", (err, result) => {
  expect(err).to.be.null;
  log.info(util.inspect(result));
});

setTimeout(() => {
  process.exit(0);
}, 3000);
