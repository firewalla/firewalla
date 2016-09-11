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
'use strict';
var log;
var instances = null;

var redis = require("redis");
var rclient = redis.createClient();
var sclient = redis.createClient();
sclient.setMaxListeners(0);

var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});
sclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});


class User {
    constructor(obj) {
        this.callbacks = {};
        this.o = obj;
    }

    getHosts(callback) {}

}


// redis 
// sys.users: name {uid}
// users.uid.<uid>: { user name ... }
// users.name.<blah>: uid

module.exports = class {
    constructor(name, loglevel) {
        if (instances == null) {
            log = require("./logger.js")("User", loglevel);
            this.name = name;
            this.hosts = {}; // all, active, dead, alarm
            this.callbacks = {};
            instances = this;
        }
        return instances;
    }

    createUser(name, callback) {}

    findUser(name, callback) {}

    findUsers(callback) {}

}
