'use strict'

/*    Copyright 2019 Firewalla LLC 
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

let firewalla = require('../net2/Firewalla.js');
let log = require('../net2/logger.js')(__filename, 'info', firewalla.getLogFolder() + "/audit.log");

function trace(msg) {
  let a = "";
  for(var i = 1; i< arguments.length; i++) {
    a += (" " + arguments[i]);
  }
  log.info(msg + a);
}

module.exports = {
  trace:trace
}
