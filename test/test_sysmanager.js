'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;


var SysManager= require('../net2/SysManager.js');
var sysManager = new SysManager('info');
var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/config.json', 'utf8'));
sysManager.setConfig(config);

setTimeout(function() {
    console.log(sysManager.myIp());
    process.exit();
},1000);

setTimeout(function() {
    console.log(sysManager.config);
    process.exit();
},3000);
