'use strict';

var chai = require('chai');
var expect = chai.expect;

let f = require('../net2/Firewalla.js');

expect(f.getFirewallaHome()).to.equal(process.env.HOME + "/firewalla");
expect(f.getUserHome()).to.equal("/home/pi");
expect(f.getHiddenFolder()).to.equal("/home/pi/.firewalla")
expect(f.isProduction()).to.equal(false);
expect(f.isDocker()).to.equal(true);

console.log(f.getVersion());

setTimeout(function() {
    process.exit();
},3000);
