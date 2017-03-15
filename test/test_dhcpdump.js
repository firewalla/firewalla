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
