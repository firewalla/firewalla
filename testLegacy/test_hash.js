'use strict';
var _ = require('underscore');
var chai = require('chai');
var expect = chai.expect;

let hashUrl = require("../util/UrlHash.js");

let hashResults = hashUrl.canonicalizeAndHashExpressions('http://a.b.c/1/2.html?param=1');
let expectedHashResults = [ [ 'a.b.c/',
    '+cFCxA==',
    '+cFCxMDJ5mngkktF9bG43R/fhdGCtnSk7EFbH1isJmc=' ],
  [ 'a.b.c/1',
    'mVGMuQ==',
    'mVGMuanhmhlENeltBEgtCWu/4SlvYHkuEvmqKiqVS3k=' ],
  [ 'a.b.c/1/2.html',
    'ixmlpQ==',
    'ixmlpREl8COvSibirvTKrjUmI9Bf/chZQzvoSCPsQFM=' ],
  [ 'a.b.c/1/2.html?param=1',
    'HNXPXg==',
    'HNXPXtjm30JL27QA97Kj/LIVxMP3+illoRRGzePBYvM=' ],
  [ 'b.c/',
    'siXPXQ==',
    'siXPXc8mbz/wsyMZpyzyP8p8U8mMtK8ae7/kE0FUB/E=' ],
  [ 'b.c/1',
    '7dZd6A==',
    '7dZd6GiExDLPFcThkYGN5kn6oKyQuVRxyFGQApcrgV0=' ],
  [ 'b.c/1/2.html',
    'GAPe5A==',
    'GAPe5HzGrewCWu/Sb/W0RAjxTW4lDe/n0K4kRPD44QY=' ],
  [ 'b.c/1/2.html?param=1',
    'm32Fuw==',
    'm32Fu9+jyLoXlqluqRCUcwNQyLEqlVICgSOxzBkYzFY=' ] ];

expect(hashResults).deep.equal(expectedHashResults.sort((a,b)=>{
  return a[0].length-b[0].length;
}));
// for (let h in hashResults) {
//   let x = hashResults[h]
//   console.log(x[0]);
// }

let hashResults2 = hashUrl.canonicalizeAndHashExpressions('http://a.b.c.d.e.f.g/1.html');

let expectedHashResults2 = [ [ 'a.b.c.d.e.f.g/',
    'zjhcWA==',
    'zjhcWMGUk9LkrCP7sdT6zN5ltzv8xPO2umKt35Bfv0E=' ],
  [ 'a.b.c.d.e.f.g/1.html',
    'jDnQww==',
    'jDnQwxEzHProeGeqUqmO88mVsSHA97x1AWSZaks6tD8=' ],
  [ 'c.d.e.f.g/',
    '8ZMKKQ==',
    '8ZMKKYzyFPBFkEmtZVg4sICpuoht0MdZ4hyK8AVSjRQ=' ],
  [ 'c.d.e.f.g/1.html',
    'N6NDzw==',
    'N6NDz10uAO6xAxdcjksK3dvvY0j2xg5zKklS/AoFPYk=' ],
  [ 'd.e.f.g/',
    'T9N/Yg==',
    'T9N/YlIMEp8pUl/T0eubBFEbYy5K7xkNvCP4UZ18zX4=' ],
  [ 'd.e.f.g/1.html',
    'AoW11Q==',
    'AoW11a0qoS/yTQ/JrIIHJQYaZZ/dNphXpCLP5MuwTk4=' ],
  [ 'e.f.g/',
    'TjeGMg==',
    'TjeGMqGGOIE2sTaJqFv2PS+Pz1DJOxRoxOIM0SQj8vg=' ],
  [ 'e.f.g/1.html',
    'paVWMg==',
    'paVWMoDy2mGOimsUBg2QlnlEZ2fH07vMI8mwJBmxIok=' ],
  [ 'f.g/',
    'lAFTDg==',
    'lAFTDuY3Hz8cuC5GMiPnv1/Tq4uFhy1HdQkRBGe0yeE=' ],
  [ 'f.g/1.html',
    '5C2Z7w==',
    '5C2Z79gg7rb613EJU0pq8bXLa9d1WVj+rZHgeQhQowM=' ] ];

expect(hashResults2).deep.equal(expectedHashResults2.sort((a,b)=>{
  return a[0].length-b[0].length;
}));

let hashResults3 = hashUrl.canonicalizeAndHashExpressions('http://1.2.3.4/1');
let expectedHashResults3 = [ [ '1.2.3.4/',
    'PwCLhg==',
    'PwCLhjym6VTDGFlmVFT5y8sQdgrLfrxTbW2hzKyUYY0=' ],
  [ '1.2.3.4/1',
    'K4TZHg==',
    'K4TZHiwzmLgrRvfCheg/Z5gKg0ZoHMbGIgh4toNi87A=' ] ];


expect(hashResults3).deep.equal(expectedHashResults3.sort((a,b)=>{
  return a[0].length-b[0].length;
}));

console.log(hashResults2.map(x => x.slice(1,3) ));


// console.log(hashUrl.canonicalizeAndHashExpressions('yahoo.com/news/something'));
// console.log(hashUrl.canonicalizeAndHashExpressions('yahoo.com/news/something?x=1&y=2'));
// console.log(hashUrl.canonicalizeAndHashExpressions('http://a.b.c/1/2.html?param=1'));
// console.log(hashUrl.canonicalizeAndHashExpressions('http://a.b.c.d.e.f.g/1.html'));

let text = "ffwap.com";
let hashes = require('../util/Hashes.js');
let hash = hashes.getHashObject(text);
console.log(text, "-", hash.hash.toString('base64'));
