'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;


var SysManager= require('../net2/SysManager.js');
var sysManager = new SysManager('info');
var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/config.json', 'utf8'));
sysManager.setConfig(config);

var Discovery = require('../net2/Discovery.js');

var discovery = new Discovery("test", config, "info");

discovery.discoverInterfaces(function(err, list) {
    console.log(list);
});

setTimeout(function() {
    sysManager.release();
    discovery.release();
    process.exit();
},3000);
