/**
 * Created by Melvin Tu on 11/01/2017.
 */

'use strict';

let chai = require('chai');
let expect = chai.expect;

let f = require('../net2/Firewalla.js');

let DHCPDUMP = require('../extension/dhcpdump/dhcpdump.js');
let d = new DHCPDUMP();

d.rawStart();

setTimeout(() => {
  d.rawStop();
}, 10000);

let mac = d.normalizeMac("a:b:c:1:2:3:4:5");
expect(mac).to.equal("0A:0B:0C:01:02:03:04:05");

setTimeout(() => {
  process.exit(0)
}, 20000);
