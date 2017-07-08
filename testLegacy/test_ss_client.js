'use strict';
let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;
let assert = chai.assert;
let log = require("../net2/logger.js")(__filename, "info");

let ss = require('../extension/ss_client/ss_client.js');

ss.stop((err) => {
  ss.start((err) => {
    expect(err).to.be.null;
  });
});

setTimeout(() => {
  process.exit(0);
}, 20000);
