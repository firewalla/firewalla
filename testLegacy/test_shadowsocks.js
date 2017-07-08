'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

var fs = require('fs');
var config = JSON.parse(fs.readFileSync('../test/ss_config.json', 'utf8'));

let shadowsocks = require('../extension/shadowsocks/shadowsocks.js');
let ss = new shadowsocks('debug');

expect(config.server).to.equal("10.0.1.7");

let encodedURI = ss.generateEncodedURI(config, "xx.ddns.com");
//ss.generateQRCode(encodedURI);
expect(encodedURI).to.equal("YWVzLTI1Ni1jZmI6dGVzdHRlc3RAeHguZGRucy5jb206ODM4OA==");

ss.refreshConfig("test12345")

let savedConfig = ss.readConfig();
expect(savedConfig.password).to.equal("test12345");

ss.refreshConfig();
let savedConfig2 = ss.readConfig();
expect(savedConfig2).to.have.property('password');
console.log(savedConfig2);

setTimeout(function() {
    process.exit();
},3000);
