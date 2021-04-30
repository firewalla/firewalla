/*    Copyright 2019 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require("../../net2/logger.js")(__filename, "info");

global.geodatadir = `${__dirname}/data`;

const geoip = require('../../vendor_lib/geoip-lite/geoip');

function getCountry(ip) {
  const result = geoip.lookup(ip);
  if (result) {
    return result.country;
  }

  return null;
}

function updateGeodatadir(dir) {
  geoip.updateGeodatadir(dir ? dir : `${__dirname}/data`)
}

module.exports = {
  getCountry: getCountry,
  reloadDataSync: geoip.reloadDataSync,
  updateGeodatadir: updateGeodatadir
};
