/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

let instance = null;
let log = require("../../net2/logger.js")(__filename, "info");

let geoip = require('geoip-country-only');

function getCountry(ip) {
  let result = geoip.lookup(ip);
  if(result) {
    return result.country;
  }

  return null;
}

module.exports = {
  getCountry: getCountry
};
