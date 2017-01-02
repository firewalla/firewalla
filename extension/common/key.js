'use strict';

var rand = require('random-seed').create();

function random() {
        var x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
}

function generatePassword(len) {
        var length = len,
            charset = "0123456789abcdefghijklmnopqrstuvwxyz",
            retVal = "";
        for (var i = 0, n = charset.length; i < length; ++i) {
            retVal += charset.charAt(Math.floor(rand(n)));
        }
        return retVal;
    }

module.exports = {
  randomPassword: generatePassword
}