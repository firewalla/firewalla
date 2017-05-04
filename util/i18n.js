'use strict'

let i18n = require('i18n');

let flat = require('flat');
let util = require('util');

let f = require('../net2/Firewalla.js');
let defaultLocale = "en";

console.log(f.getLocalesDirectory());
i18n.configure({
  directory: f.getLocalesDirectory(),
  defaultLocale: defaultLocale
});

function m(msgTemplate, info) {
  console.log("1 " + msgTemplate);
  console.log(info);
  console.log("2 " + util.inspect(flat.unflatten(info)));
  return i18n.__(msgTemplate, flat.unflatten(info));
}

module.exports = {
  "__": m
};

