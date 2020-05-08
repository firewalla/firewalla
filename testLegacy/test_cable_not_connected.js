'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;


var sysManager = require('../net2/SysManager.js');
var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/config.json', 'utf8'));
sysManager.setConfig(config);

var Discovery = require('../net2/Discovery.js');

var discovery = new Discovery("test", config, "debug");

discovery.discoverInterfaces(function(err, list) {
	if(list.length == 0) {
		console.log("no ethernet cable is connected");
	} else {
		console.log("ethernet cable is connected");
	}
});

setTimeout(function() {
    sysManager.release();
    discovery.release();
    process.exit();
},3000);
