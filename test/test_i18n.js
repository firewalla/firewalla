#!/bin/env node

'use strict';

let chai = require('chai');
let expect = chai.expect;

let i18n = require('../util/i18n.js');

console.log(i18n.__("ALARM_PORN"));
console.log(i18n.__("ALARM_PORN", { "p.device.name": "nnname", "p.dest.name": "Youku.com" }));
console.log(i18n.__("ALARM_PORN2", { "p.device.name": "nnname", "pdevice": "nnnnn" }));
