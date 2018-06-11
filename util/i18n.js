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

module.exports = {
  "__": m,
  // setLocale: i18n.setLocale,
  setLocale: () => {}, // disable set locale feature for now
  getLocale: i18n.getLocale
};

