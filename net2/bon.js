/*    Copyright 2016 Rottiesoft LLC 
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

var bonjour = require('bonjour')();

/*
bonjour.find({protocol:'tcp'}, function(service) {
    console.log(service);
});
*/
var b = bonjour.find({
    protocol: "*"
}, function (service) {
    //    console.log(service);
});
/*
var b = bonjour.find({}, function(service) {
    console.log(service.name);
});
*/
var IntelManager = require('./IntelManager.js');
var im = new IntelManager('debug');
//im.lookup('211.90.28.98',(err,obj,url)=> {
//im.lookup('203.130.54.225',(err,obj,url)=> {
//    console.log(obj,url);
//});
b.start();

/*
var iptable = require('./Iptables.js');

iptable.drop({
   action:'-D',
   chain: "FORWARD",
   src: '192.168.2.230',
   protocol:'tcp',
   dport: 80,
   sudo: true,
});

*/
var redis = require("redis");
var rclient = redis.createClient();

var expireDate = Date.now() / 1000 - 5 * 60 * 60;
rclient.zremrangebyscore("flow:conn:in:192.168.2.106", "-inf", expireDate, (err, data) => {
    console.log("zremrangedby");
    console.log(err, data);
});
rclient.zremrangebyscore("flow:conn:out:192.168.2.106", "-inf", expireDate, (err, data) => {
    console.log("zremrangedby");
    console.log(err, data);
});

var AppManager = require("./AppManager.js");
var am = new AppManager("./appSignature.json", 'debug');

setTimeout(() => {
    am.query("messenger.facebook.com", null, (err, result) => {
        console.log(result);
    });
    am.query("test.apple.com", null, (err, result) => {
        console.log(result);
    });
}, 2000);


var redis = require("redis");
var rclient = redis.createClient();
