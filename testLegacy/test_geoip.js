'use strict';
let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;

let geoip = require('geoip-lite');
let ip = "116.226.66.73";
let geo = geoip.lookup(ip);
console.log(geo);


let country = require('../extension/country/country.js');
console.log(country.getCountry(ip));
  
setTimeout(() => {
  process.exit(0);
}, 3000);
