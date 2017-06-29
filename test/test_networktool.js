#!/bin/env node

'use strict';

let chai = require('chai');
let expect = chai.expect;

let networkTool = require('../net2/NetworkTool')();

networkTool.getLocalNetworkInterface().then((intf) => {
  expect(intf).not.to.be.null;
});

setTimeout(() => {
  process.exit(0);
}, 3000);