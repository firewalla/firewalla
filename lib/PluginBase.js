/*    Copyright 2016 Firewalla LLC 
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

var log = null;
var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');

const rclient = require('../util/redis_manager.js').getRedisClient()

var later = require('later');
var forever = require('forever-monitor');

module.exports = class {
    constructor(path, name, loglevel) {
        log = require("./logger.js")("plugin manager", loglevel);
       // var fs = require('fs');
       // var config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    }

    install(callback) {
    }

    uninstall(callback) {
    }

    enable(opts, callback) {
    }

    disable(opts,callback) {
    } 
}
