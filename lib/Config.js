/*    Copyright 2016 Firewalla INC
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
/* 
 * Image processor
 */

'use strict'

var globalConfig = null;
var fs = require("fs");

class Config {

    constructor(configpath) {
        if (globalConfig == null) {
            if (arguments.length == 0) {
                return;
            }
            console.log(arguments.length);
            let configfile = fs.readFileSync(configpath, 'utf8');
            if (configfile == null) {
                console.log("Unable to read config file");
            }
            let config = JSON.parse(configfile);
            if (!config) {
                console.log("Error processing configuration information");
            }
            globalConfig = config;
        }
    }

    config() {
        return globalConfig;
    }

};

module.exports = Config;
