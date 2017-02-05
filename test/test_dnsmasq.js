/**
 * Created by Melvin Tu on 11/01/2017.
 */

'use strict';

let chai = require('chai');
let expect = chai.expect;

let Firewalla = require('../net2/Firewalla.js');
let f = new Firewalla("config.json", 'info');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq');
let dnsmasq = new DNSMASQ();

dnsmasq.updateFilter();