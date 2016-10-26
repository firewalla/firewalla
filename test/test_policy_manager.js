'use strict';

var chai = require('chai');
var expect = chai.expect;

var PolicyManager = require('../net2/PolicyManager.js');
var policyManager = new PolicyManager('info');

expect(policyManager.is_ip_valid('192.168.0.1')).to.equal(1);
expect(policyManager.is_ip_valid('169.254.2.18')).to.equal(0);

setTimeout(function() {
    process.exit();
},3000);
