/*    Copyright 2016 - 2019 Firewalla INC 
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
var winston = require('winston');

var logger = null;

var node_env = process.env.NODE_ENV || 'devlocal';
var node_logger = process.env.NODE_LOG || 'debug';

/*
 * production logger and developer logger definitions 
 *
 */

if (node_env !== 'production') {
    logger = new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({'timestamp':true }),
        ]
    });
    logger.transports.console.level = 'debug';
    console.log("Development Logger initialized to "+logger.transports.console.level);
} else {
    logger = new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({ level: 'error','timestamp':true }),
            new (winston.transports.File)({name:'log-file', filename: 'somefile.log','timestamp':true })
        ]
    });
    logger.transports.console.level = 'warn';
    console.log("Production Logger initialized to "+logger.transports.console.level);
}

if (node_logger !== null) {

}

module.exports = logger;
