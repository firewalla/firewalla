/*    Copyright 2016-2019 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

let hashUrl = require("./UrlHash.js");

console.log(hashUrl.canonicalizeAndHashExpressions('http://yahoo.com'));
console.log(hashUrl.canonicalizeAndHashExpressions('yahoo.com/news/something'));
console.log(hashUrl.canonicalizeAndHashExpressions('yahoo.com/news/something?x=1&y=2'));
console.log(hashUrl.canonicalizeAndHashExpressions('http://a.b.c/1/2.html?param=1'));
console.log(hashUrl.canonicalizeAndHashExpressions('http://a.b.c.d.e.f.g/1.html'));
console.log(hashUrl.canonicalizeAndHashExpressions('10.0.0.1'));
console.log(hashUrl.shortUrl("http://y.b.yahoo.com",true));
console.log(hashUrl.shortUrl("http://y.b.yahoo.com/blah/sdfsd/dfdsf?sdf",true));

let FlowUtil = require('../net2/FlowUtil.js');

console.log(FlowUtil.hashHost("yahoo.com"));
console.log(FlowUtil.hashHost("www.yahoo.com"));
console.log(FlowUtil.hashHost("10.10.2.3"));
console.log(FlowUtil.hashHost("www.wechat.com"));
console.log(FlowUtil.hashApp("www.wechat.com"));
console.log(FlowUtil.hashApp("123.www.netflix.com"));
console.log("TESTING HASH FLOW HASHIP");
console.log(FlowUtil.hashIp("10.0.0.1"));
console.log("TESTING HASH FLOW HASHMAC");
console.log(FlowUtil.hashMac("10.0.0.1/"));
console.log("TESTING HASH FLOW HASHMAC2");
console.log(FlowUtil.hashMac("aa:bb:cc:dd:ee:ff"));
console.log(FlowUtil.hashMac("aa:bb:cc:dd:ee:fe"));

let hash = require("./Hashes.js");
console.log(hash.getHashObject("abc"));
console.log(hash.getNormalizedPrefix("abc"));


/*
  it('should work with http://a.b.c/1/2.html?param=1', function() {
    expect(_.difference(
      getLookupExpressions('http://a.b.c/1/2.html?param=1'),
      [
        'a.b.c/1/2.html?param=1',
        'a.b.c/1/2.html',
        'a.b.c/',
        'a.b.c/1/',
        'b.c/1/2.html?param=1',
        'b.c/1/2.html',
        'b.c/',
        'b.c/1/'
      ]
    )).toEqual([]);
  });

  it('should work with http://a.b.c.d.e.f.g/1.html', function() {
    expect(_.difference(
      getLookupExpressions('http://a.b.c.d.e.f.g/1.html'),
      [
        'a.b.c.d.e.f.g/1.html',
        'a.b.c.d.e.f.g/',
        'c.d.e.f.g/1.html',
        'c.d.e.f.g/',
        'd.e.f.g/1.html',
        'd.e.f.g/',
        'e.f.g/1.html',
        'e.f.g/',
        'f.g/1.html',
        'f.g/'
      ]
    )).toEqual([]);
  });

  it('should work with http://1.2.3.4/1/', function() {
    expect(_.difference(
      getLookupExpressions('http://1.2.3.4/1/'),
      [
        '1.2.3.4/1/',
        '1.2.3.4/'
      ]
    )).toEqual([]);
  });
*/
