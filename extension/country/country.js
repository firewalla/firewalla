/**
 * Created by Melvin Tu on 04/01/2017.
 */

'use strict';

const log = require("../../net2/logger.js")(__filename, "info");

global.geodatadir = `${__dirname}/data`;

const geoip = require('geoip-lite');

function getCountry(ip) {
  const result = geoip.lookup(ip);
  if(result) {
    return result.country;
  }

  return null;
}

module.exports = {
  getCountry: getCountry
};
