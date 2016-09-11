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

var logger;
var Tail = require('always-tail');
var fs = require('fs');
var filename = "/tmp/testlog";

if (!fs.existsSync(filename)) fs.writeFileSync(filename, "");

var tail = new Tail(filename, '\n');

tail.on('line', function (data) {
    console.log("got line:", data);
});


tail.on('error', function (data) {
    console.log("error:", data);
});

tail.watch();

/*
 * 
 *  config.bro.path{ 
 *      intel
 *      notice
 *  }
 *
 */

module.exports = class {

    constructor(config, loglevel) {
        this.config = config;
        logger = require("./logger.js")("discover", loglevel);
        var intelLog = new Tail(config.bro.path.intel, '\n');
        intelLog.on('line', processIntelData);
        var noticeLog = new Tail(config.bro.path.notice, '\n');
        noticeLog.on('line', processNoticeData);
    }

    processIntelData(data) {

    }

    processNoticeData(data) {}

    on(something, callback) {
        this.callbacks[something] = callback;
    }

}
