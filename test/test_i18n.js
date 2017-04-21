#!/bin/env node

'use strict';

let chai = require('chai');
let expect = chai.expect;

let i18n = require('i18n');

i18n.configure({
  directory: __dirname + "/../locales",
  defaultLocale: 'zh'
});

console.log(i18n.__("hello"));
