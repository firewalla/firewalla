'use strict';

const f = require('../../net2/Firewalla.js');
const fHome = f.getFirewallaHome();
var fs = require('fs');
var contents = fs.readFileSync(fHome + '/vendor_lib/pinyin/data/pinyin.txt', 'utf8');
var arr = contents.split(/\r?\n/);
var table = [];
arr.forEach(function (e) {
    var cc = e.substr(0, 1);
    var pp = e.substr(1).split(',')[0].slice(0, -1);
    table[cc] = pp;
});

const pinyin = (s) => {
    var ns = '';
    var len = s.length;
    for (var i = 0; i < len; ++i) {
        ns += table[s[i]] ? (table[s[i]] + " ") : s[i];
    }
    return ns.trim();
}

module.exports = pinyin;