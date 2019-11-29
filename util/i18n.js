/*    Copyright 2016-2019 Firewalla INC
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

'use strict'

let i18n = require('i18n');

let flat = require('flat');
let util = require('util');

let f = require('../net2/Firewalla.js');
let defaultLocale = "en";
// let moment = require("moment");

i18n.configure({
  locales:['en', 'zh'],
  directory: f.getLocalesDirectory(),
  defaultLocale: defaultLocale,
  updateFiles: false
});
// moment.locale(defaultLocale);

function m(msgTemplate, info) {
  return i18n.__(msgTemplate, flat.unflatten(info));
}

function mf(msgTemplate, info) {
  return i18n.__mf(msgTemplate, flat.unflatten(info));
}

module.exports = {
  "__": m,
  // setLocale: i18n.setLocale,
  "__mf": mf,
  setLocale: () => {}, // disable set locale feature for now
  getLocale: i18n.getLocale
};

