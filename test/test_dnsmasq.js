/**
 * Created by Melvin Tu on 11/01/2017.
 */

'use strict';

let chai = require('chai');
let expect = chai.expect;

let f = require('../net2/Firewalla.js');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq');
let dnsmasq = new DNSMASQ();

dnsmasq.updateFilter();
