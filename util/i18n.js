'use strict'

let i18n = require('i18n');

let flat = require('flat');
let util = require('util');

let f = require('../net2/Firewalla.js');
let defaultLocale = "en";
// let moment = require("moment");

i18n.configure({
  locales:['en', 'cn'],
  directory: f.getLocalesDirectory(),
  defaultLocale: defaultLocale,
  updateFiles: false
});
// moment.locale(defaultLocale);

function m(msgTemplate, info) {
  return i18n.__(msgTemplate, flat.unflatten(info));
}

function setLocale(locale) {
  return i18n.setLocale(locale);
  // moment.locale(locale);
}

module.exports = {
  "__": m,
  setLocale: setLocale
};

