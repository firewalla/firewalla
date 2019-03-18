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

var instance = null;
var log = null;
var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');

const rclient = require('../util/redis_manager.js').getRedisClient()

var later = require('later');
var forever = require('forever-monitor');

module.exports = class {
    constructor(path, loglevel) {
        if (instance == null) {
            log = require("./logger.js")("plugin manager", loglevel);
            instance = this;
        }
        return instance;
    }


    launchService(program, callback) {
        var args = ['--gid', gid, '--config', program.config];
        console.log("Launching Service", gid, config.appId, config.appSecret, config.endpoint_name, 'args', args);

        var child = new(forever.Monitor)('../controllers/MomBot.js', {
            max: 30,
            silent: false,
            outFile: "/tmp/"+program+"_plugin_forever.out",
            logFile: "/tmp/"+program+"_plugin_forever.log",
            errFile: "/tmp/"+program+"_plugin_forever.err",
        });


        child.on('watch:restart', function (info) {
            console.error('Restaring script because ' + info.file + ' changed');
        });

        child.on('restart', function () {
            console.error('Forever restarting script for ' + child.times + ' time');
        });

        child.on('exit:code', function (code) {
            console.error('Forever detected script exited with code ' + code);
        });

        child.start();
    }
}
